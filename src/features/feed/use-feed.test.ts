import { act, waitFor } from '@testing-library/react-native';

import { renderHookWithProviders } from '@/test-utils/render';

import { feedItems, FEED_PAGE_SIZE, useActorActivity, useFeed } from './use-feed';

let mockFeedRows: unknown[] = [];
let mockNoteRows: unknown[] = [];
let mockNoteError: unknown = null;
const rpcCalls: { name: string; args: Record<string, unknown> }[] = [];
/**
 * Every `.order()` the feed asks for, per table.
 *
 * Recorded rather than discarded, because the ordering **is** the contract here. The
 * rows come back from a stub in whatever order the fixture wrote them, so no assertion
 * over the returned array could tell a correct sort from a missing one -- the sort
 * happens in PostgreSQL. What this file can prove is which clause was requested, and
 * `supabase/tests/physical-qa.test.mjs` proves what that clause does to real rows.
 * Together they are the property; on its own neither is.
 */
const orderCalls: Record<string, { column: string; ascending: boolean }[]> = {};

/**
 * Every read of `feed_events`, in order, with what the caller asked for.
 *
 * Recorded because pagination *is* the request: no assertion over the rows a stub
 * returned could tell a page-2 read from a repeated page-1 read. What this file can
 * prove is the filter, the projection and the limit on each successive read, and that
 * page 2's differs from page 1's in exactly one clause.
 */
type MockFeedRead = {
  select: string | null;
  or: string | null;
  in: Record<string, unknown[]>;
  limit: number | null;
};
const mockFeedReads: MockFeedRead[] = [];

/**
 * What the next read of `feed_events` returns, one entry per read.
 *
 * The queue is how a two-page feed is expressed: shift an answer per read, and fall
 * back to `mockFeedRows` once it is empty, so every suite written before pagination
 * existed keeps its single-page behaviour untouched.
 */
let mockFeedQueue: { rows?: unknown[]; error?: unknown }[] = [];

jest.mock('@/lib/supabase', () => ({
  supabase: {
    rpc: (name: string, args: Record<string, unknown>) => {
      rpcCalls.push({ name, args });
      return Promise.resolve({ data: mockNoteError ? null : mockNoteRows, error: mockNoteError });
    },
    from: (table: string) => {
      const chain: Record<string, unknown> = {};
      orderCalls[table] ??= [];
      const read: MockFeedRead = { select: null, or: null, in: {}, limit: null };
      const result = () => {
        if (table === 'follows') {
          return Promise.resolve({ data: [{ followee_id: 'friend' }], error: null });
        }
        if (table !== 'feed_events') return Promise.resolve({ data: [], error: null });
        mockFeedReads.push(read);
        const next = mockFeedQueue.shift();
        if (next?.error) return Promise.resolve({ data: null, error: next.error });
        return Promise.resolve({ data: next?.rows ?? mockFeedRows, error: null });
      };
      Object.assign(chain, {
        select: (columns: string) => {
          read.select = columns;
          return chain;
        },
        eq: () => chain,
        or: (filter: string) => {
          read.or = filter;
          return chain;
        },
        in: (column: string, values: unknown[]) => {
          read.in[column] = values;
          return chain;
        },
        order: (column: string, options?: { ascending?: boolean }) => {
          orderCalls[table]?.push({ column, ascending: options?.ascending !== false });
          return chain;
        },
        limit: (count: number) => {
          read.limit = count;
          return result();
        },
        then: (resolve: (value: unknown) => unknown) => result().then(resolve),
      });
      return chain;
    },
  },
  startSessionRefresh: () => () => {},
}));

const media = {
  kind: 'movie',
  title: 'Inception',
  release_date: '2010-07-16',
  poster_path: '/p.jpg',
  genres: ['Science Fiction'],
  runtime_minutes: 148,
  parent: null,
};

const profile = { username: 'sai', display_name: 'Sai', avatar_path: null };

const event = (over: Record<string, unknown> = {}) => {
  const row = {
    id: 'event-1',
    type: 'title_ranked',
    actor_id: 'user-1',
    media_item_id: 'film-1',
    created_at: '2026-08-15T00:00:00Z',
    causal_step: 0,
    payload: { position: 1, category: 'movies', bucket: 'loved', score: 8.7 },
    media_items: media,
    profiles: profile,
    ...over,
  };
  // The feed's sort key (20260901000100). `not null` in the schema and equal to
  // `created_at` for everything but a goal completion, so a fixture that omits it is a
  // row the database cannot produce — and the ordering the screen is being asked about
  // would be decided by the id tiebreak instead.
  return { causal_at: row.created_at, ...row };
};

/**
 * Mount the feed and wait for its first page.
 *
 * Returns the *flattened* list, through the same `feedItems` the screen uses, so every
 * assertion in this file is about what a reader sees rather than about a page shape.
 */
const load = async () => {
  const view = await renderHookWithProviders(() => useFeed('user-1'));
  await waitFor(() => expect(view.result.current.isPending).toBe(false));
  return feedItems(view.result.current.data?.pages);
};

/**
 * Mount the feed and keep the hook, for the tests that page it.
 *
 * The hook body reads the fields the assertions below read, and that is not decoration.
 * React Query tracks which properties a component touched **during render** and re-renders
 * only when one of those changes; a hook that returns the result object without reading
 * anything from it tracks nothing, and a test reading `isError` off it afterwards is
 * reading a snapshot that was never refreshed. Touching them here is what subscribes.
 */
const open = async () => {
  const view = await renderHookWithProviders(() => {
    const query = useFeed('user-1');
    void query.status;
    void query.isError;
    void query.hasNextPage;
    void query.isFetchingNextPage;
    void query.data;
    return query;
  });
  await waitFor(() => expect(view.result.current.isPending).toBe(false));
  return {
    view,
    feed: () => view.result.current,
    items: () => feedItems(view.result.current.data?.pages),
  };
};

/** The single item under test, so each assertion is not preceded by a null check. */
const only = async () => {
  const [item] = await load();
  if (!item) throw new Error('the feed returned nothing');
  return item;
};

beforeEach(() => {
  mockFeedRows = [];
  mockNoteRows = [];
  mockNoteError = null;
  rpcCalls.length = 0;
  mockFeedReads.length = 0;
  mockFeedQueue = [];
});

describe('the embedded profile', () => {
  it('reads a to-one embed returned as an object', async () => {
    // The whole "Someone ranked a title." bug in one assertion. PostgREST hands
    // back an object here and its types say array, so `profiles[0]` was
    // undefined on every row and every fallback fired at once.
    mockFeedRows = [event()];

    const item = await only();
    expect(item.actorName).toBe('Sai');
    expect(item.title).toBe('Inception');
  });

  it('still reads one returned as an array', async () => {
    // Belt and braces: a to-many embed, or a PostgREST version that shapes this
    // differently, must not reintroduce the bug in the other direction.
    mockFeedRows = [event({ profiles: [profile], media_items: [media] })];

    const item = await only();
    expect(item.actorName).toBe('Sai');
    expect(item.title).toBe('Inception');
  });

  it('falls back to the username when there is no display name', async () => {
    mockFeedRows = [event({ profiles: { ...profile, display_name: null } })];

    const item = await only();
    expect(item.actorName).toBe('sai');
  });

  it('drops an item whose actor cannot be named', async () => {
    // Omission, not "Someone". A feed with one item is honest; two, one of them
    // about nobody, is not. screens.md §7.
    mockFeedRows = [event(), event({ id: 'event-2', profiles: null })];

    const items = await load();
    expect(items.map((item) => item.id)).toEqual(['event-1']);
  });

  it('drops an item whose profile has only an empty name', async () => {
    mockFeedRows = [event({ profiles: { username: '', display_name: '', avatar_path: null } })];
    expect(await load()).toHaveLength(0);
  });
});

describe('the score', () => {
  it('comes from the payload, not from a derivation', async () => {
    // A viewer cannot compute a friend's score: it needs that friend's band
    // sizes, and `rankings` is scoped to its owner by RLS. `_rank_finalize`
    // snapshots it instead (20260815010000).
    mockFeedRows = [event()];

    const item = await only();
    expect(item.score).toBe(8.7);
    expect(item.bucket).toBe('loved');
  });

  it('is null on an event written before the snapshot existed', async () => {
    mockFeedRows = [event({ payload: { position: 3, category: 'movies' } })];

    const item = await only();
    expect(item.score).toBeNull();
    expect(item.bucket).toBeNull();
  });
});

describe('the title card', () => {
  it('carries the year, runtime and genres the compact row needs', async () => {
    mockFeedRows = [event()];

    const item = await only();
    expect(item.year).toBe(2010);
    expect(item.runtimeMinutes).toBe(148);
    expect(item.genres).toEqual(['Science Fiction']);
  });

  it('survives a media row with nothing but a title', async () => {
    mockFeedRows = [
      event({
        media_items: {
          kind: 'movie',
          title: 'Untitled',
          release_date: null,
          poster_path: null,
          genres: null,
          runtime_minutes: null,
          parent: null,
        },
      }),
    ];

    const item = await only();
    expect(item.year).toBeNull();
    expect(item.genres).toEqual([]);
  });
});

/**
 * "Suraj Kandukuri ranked Season 2" was the device-test finding. A feed never shows
 * the parent series beside the season, so the season's own title names nothing.
 */
describe('a season in the feed', () => {
  const season = (parent: unknown) => ({
    kind: 'season',
    title: 'Season 2',
    release_date: '2010-09-17',
    poster_path: null,
    genres: ['Comedy'],
    runtime_minutes: 22,
    parent,
  });

  it('carries the series name with it', async () => {
    mockFeedRows = [event({ media_items: season({ title: 'Parks and Recreation' }) })];

    const item = await only();
    expect(item.title).toBe('Parks and Recreation, S2');
    expect(item.kind).toBe('season');
  });

  it('reads the parent embed whether it arrives as an object or an array', async () => {
    mockFeedRows = [event({ media_items: season([{ title: 'Parks and Recreation' }]) })];
    expect((await only()).title).toBe('Parks and Recreation, S2');
  });

  it('falls back to the season alone rather than to nothing', async () => {
    mockFeedRows = [event({ media_items: season(null) })];
    expect((await only()).title).toBe('Season 2');
  });
});

describe('the note attached to an activity', () => {
  it('asks for public notes by the actors and titles on screen', async () => {
    mockFeedRows = [event()];
    await load();

    const call = rpcCalls.find((c) => c.name === 'public_notes');
    expect(call?.args.p_user_ids).toEqual(['user-1']);
    expect(call?.args.p_media_item_ids).toEqual(['film-1']);
  });

  it('matches a note to its own author and title, not to the other pairing', async () => {
    mockFeedRows = [
      event(),
      event({ id: 'event-2', actor_id: 'friend', media_item_id: 'film-2' }),
    ];
    // The RPC filters are a cross product, so it can legitimately return a pair
    // that belongs to neither event. Matching on both halves is what stops one
    // person's note appearing under another person's activity.
    mockNoteRows = [
      { user_id: 'user-1', media_item_id: 'film-2', note: 'wrong pairing', has_spoilers: false },
      { user_id: 'friend', media_item_id: 'film-2', note: 'the right one', has_spoilers: true },
    ];

    const [mine, theirs] = await load();
    expect(mine?.note).toBeNull();
    expect(theirs?.note).toEqual({ text: 'the right one', hasSpoilers: true });
  });

  it('keeps the feed when the note read fails', async () => {
    // A note is an enrichment. Losing the whole feed because it could not be
    // fetched trades a small absence for a total one.
    mockFeedRows = [event()];
    mockNoteError = { message: 'nope' };

    const item = await only();
    expect(item.title).toBe('Inception');
    expect(item.note).toBeNull();
  });
});

/**
 * Founder Feed finalization, 2026-08-20, items 2, 7 and 8.
 *
 * A watchlist add is now activity, and the standardised subheading needs two fields
 * the read was not asking for — the content rating, and a season's episode count.
 */
describe('a watchlist add in the feed', () => {
  it('is fetched, and is not mistaken for a watch', async () => {
    mockFeedRows = [event({ type: 'watchlist_added', payload: {} })];

    const item = await only();
    expect(item.type).toBe('watchlist_added');
    expect(item.title).toBe('Inception');
    // No ranking happened, so there is no score and the badge does not draw.
    expect(item.score).toBeNull();
  });

  it('carries neither a note nor companions, even when the actor wrote one', async () => {
    // The trap this closes. Notes and tags are matched on (actor, title) rather than
    // on the event — deliberately, so both stay live and retractable — which means a
    // watchlist row for a film its actor later watched, reviewed and tagged would
    // otherwise render "added Dune to their watchlist with Anna" under a verdict on
    // the film. An intention is not a viewing.
    mockFeedRows = [
      event({ id: 'watch-1', type: 'title_ranked' }),
      event({ id: 'watch-2', type: 'watchlist_added', payload: {} }),
    ];
    mockNoteRows = [
      { user_id: 'user-1', media_item_id: 'film-1', note: 'Best of the year.', has_spoilers: false },
    ];

    const [ranked, saved] = await load();
    expect(ranked?.note).toEqual({ text: 'Best of the year.', hasSpoilers: false });
    expect(saved?.note).toBeNull();
    expect(saved?.companions).toEqual([]);
  });

  it('does not ask the note RPC about an activity that cannot have one', async () => {
    mockFeedRows = [event({ type: 'watchlist_added', payload: {} })];
    await load();

    expect(rpcCalls.find((c) => c.name === 'public_notes')).toBeUndefined();
  });
});

describe('an award in the feed (20260828000100)', () => {
  const awardEvent = () =>
    event({
      type: 'award_earned',
      media_item_id: null,
      media_items: null,
      payload: {
        award: 'movie-muncher',
        tier: 'bronze',
        award_name: 'Movie Muncher',
        tier_label: 'Bronze',
      },
    });

  it('puts the award name in the sentence slot, so the grammar reads "earned Movie Muncher"', async () => {
    mockFeedRows = [awardEvent()];

    const item = await only();
    expect(item.type).toBe('award_earned');
    // No media row at all — the title is the payload's award name, not a film.
    expect(item.mediaItemId).toBeNull();
    // Movie Muncher's tiers are metals, so the family name IS the earned name —
    // `awardAnnouncement`'s one exception, and the reason the founder's own example
    // copy reads "earned the Movie Muncher award".
    expect(item.title).toBe('Movie Muncher');
    expect(item.award).toEqual({
      key: 'movie-muncher',
      tierKey: 'bronze',
      title: 'Movie Muncher',
      // The second line, from the canonical threshold rather than from "Bronze".
      achievement: 'Watched 50 movies',
    });
    // Nothing film-shaped leaks onto the row: no score badge, no poster path.
    expect(item.score).toBeNull();
    expect(item.posterPath).toBeNull();
  });

  it('carries neither a note nor companions, and asks the note RPC nothing', async () => {
    // An award is not a watch claim, so the (actor, title) note/tag joins must not
    // run — the watchlist row's rule, restated for the second non-watch type.
    mockFeedRows = [awardEvent()];
    const item = await only();

    expect(item.note).toBeNull();
    expect(item.companions).toEqual([]);
    expect(rpcCalls.find((c) => c.name === 'public_notes')).toBeUndefined();
  });

  it('titles a creative track by the tier that was earned, not by the family', async () => {
    // The founder's mismatch: the notification said "Comment Gremlin" — the track's
    // family name — while the Awards sheet said "Whisper", the tier actually earned.
    // Both surfaces read `awardAnnouncement` now, and this is the half of it the feed
    // draws.
    mockFeedRows = [
      event({
        type: 'award_earned',
        media_item_id: null,
        media_items: null,
        payload: {
          award: 'comment-gremlin',
          tier: 'whisper',
          award_name: 'Comment Gremlin',
          tier_label: 'Whisper',
        },
      }),
    ];

    const item = await only();
    expect(item.title).toBe('Whisper');
    expect(item.award?.achievement).toBe('Wrote 20 comments');
  });

  it('falls back to the payload for a track this bundle has never heard of', async () => {
    // A row can outlive the bundle that understands it. The two wrong answers are not
    // equal: printing the key would be showing somebody `future-track`, which
    // `tracks.ts` forbids in as many words. The threshold line is dropped rather than
    // guessed at, because a second line naming the wrong number is worse than none.
    mockFeedRows = [
      event({
        type: 'award_earned',
        media_item_id: null,
        media_items: null,
        payload: {
          award: 'future-track',
          tier: 'tier-1',
          award_name: 'Future Track',
          tier_label: 'First',
        },
      }),
    ];

    const item = await only();
    expect(item.title).toBe('Future Track');
    expect(item.award?.achievement).toBeNull();
  });

  it('still says something honest when the payload predates the names', async () => {
    mockFeedRows = [
      event({
        type: 'award_earned',
        media_item_id: null,
        media_items: null,
        payload: { award: 'future-track', tier: 'tier-1' },
      }),
    ];

    const item = await only();
    // No leading article: the sentence supplies one now ("earned the …"), and
    // `tailFor` drops its trailing "award" for a name that already says it — so this
    // row reads "Abisola earned the bingd. Award" rather than stacking either word.
    // The inbox's own last resort is "a new Award", because its sentence is "You
    // earned …" — which is why `awardAnnouncement` takes the fallback rather than
    // choosing one for both surfaces.
    expect(item.title).toBe('bingd. Award');
    expect(item.award?.achievement).toBeNull();
  });
});

describe('the fields the subheading needs', () => {
  it('reads a movie’s own rating and runtime', async () => {
    mockFeedRows = [
      event({ media_items: { ...media, certification: 'PG-13', episode_count: null } }),
    ];

    const item = await only();
    expect(item.certification).toBe('PG-13');
    expect(item.runtimeMinutes).toBe(148);
    expect(item.episodeCount).toBeNull();
  });

  it('gives a season its episode count and its series’ rating and genres', async () => {
    // `tmdb_upsert_seasons` writes neither genres nor a certification, and TMDB
    // publishes the rating on the series. Both come off the parent embed this query
    // was already making for the title.
    mockFeedRows = [
      event({
        media_items: {
          kind: 'season',
          title: 'Season 2',
          season_number: 2,
          release_date: '2025-01-17',
          poster_path: null,
          genres: [],
          certification: null,
          runtime_minutes: 50,
          episode_count: 8,
          parent: {
            title: 'Severance',
            genres: ['Drama', 'Thriller'],
            certification: 'TV-MA',
          },
        },
      }),
    ];

    const item = await only();
    expect(item.title).toBe('Severance, S2');
    expect(item.certification).toBe('TV-MA');
    expect(item.genres).toEqual(['Drama', 'Thriller']);
    expect(item.episodeCount).toBe(8);
  });

  it('leaves both absent when nobody published them', async () => {
    mockFeedRows = [event()];

    const item = await only();
    expect(item.certification).toBeNull();
    expect(item.episodeCount).toBeNull();
  });
});

/**
 * **The causal order, as the query asks for it** (20260902000100).
 *
 * The founder's report: ranking a film that earns an award showed the ranking above the
 * award, and this feed is newest-first. The award is the later event.
 *
 * The fix is one word in the ORDER BY and deliberately **not** a reverse of the array
 * the hook returns. A client-side reversal would fix the screen and break pagination:
 * the second page is fetched by the server in server order, so a list assembled by
 * reversing each page would interleave the two wrongly at the seam. So what is asserted
 * here is the clause, on the exact query every one of the three activity surfaces runs.
 */
describe('the feed asks for its rows newest-first, consequences above causes', () => {
  const clause = () => orderCalls['feed_events'] ?? [];

  // Module-level, and every other suite in this file also loads the feed. Cleared
  // here so an assertion is about this load rather than about every load so far.
  beforeEach(() => {
    orderCalls['feed_events'] = [];
  });

  it('orders by causal_at descending, then causal_step descending, then id', async () => {
    mockFeedRows = [event()];
    await load();

    expect(clause()).toEqual([
      // The group's own instant. A goal completion inherits the timestamp of the
      // activity it belongs under, which is what holds a causal group together.
      { column: 'causal_at', ascending: false },
      // **Descending**, which is the correction. 0 is the act, 1 the goal it completed,
      // 2 and up the awards it earned; a higher step is a later event, so newest-first
      // puts the award above the ranking that produced it.
      { column: 'causal_step', ascending: false },
      // Total, because it is a primary key. Without it two rows the first two keys
      // cannot separate are free to swap between pages, which drops or duplicates an
      // activity at a page boundary.
      { column: 'id', ascending: true },
    ]);
  });

  it('asks for the same clause on every fetch, so a refetch cannot reorder the list', async () => {
    // One reader, `activityBy`, serves the feed, a profile's activity and a paginated
    // page alike. Two loads therefore have to produce two identical clauses -- and a
    // per-call ordering, or a sort applied only on first paint, is what this refuses.
    mockFeedRows = [event()];
    await load();
    const first = [...clause()];
    orderCalls['feed_events'] = [];
    await load();

    expect(clause()).toEqual(first);
  });
});

/**
 * ---------------------------------------------------------------------------
 * PAGINATION (2026-09-04)
 *
 * The defect: the feed read 30 rows once and never asked for a thirty-first. A network
 * that had produced more than thirty eligible activities showed thirty of them and then
 * looked finished, which is indistinguishable from having reached the end.
 *
 * What follows asserts the *requests*, not the returned arrays, and deliberately. The
 * rows come back from a stub in whatever order the fixture wrote them, so no assertion
 * over the result could tell a correct page 2 from page 1 fetched twice. The requests are
 * what the client controls; `supabase/tests` is what proves PostgreSQL agrees.
 */

/** A row `n` steps down the fixture list, so a page has distinguishable members. */
const nth = (n: number, over: Record<string, unknown> = {}) =>
  event({
    id: `event-${String(n).padStart(3, '0')}`,
    created_at: `2026-08-${String(28 - (n % 27)).padStart(2, '0')}T00:00:00Z`,
    ...over,
  });

/** A full page of distinct rows, which is what tells the reader there may be more. */
const fullPage = (from = 0) =>
  Array.from({ length: FEED_PAGE_SIZE }, (_, i) => nth(from + i));

const feedRead = (n: number) => {
  const read = mockFeedReads[n];
  if (!read) throw new Error(`the feed made ${mockFeedReads.length} reads, not ${n + 1}`);
  return read;
};

describe('the first page', () => {
  it('asks for one page of rows and no more', async () => {
    mockFeedRows = fullPage();
    const items = await load();

    expect(feedRead(0).limit).toBe(FEED_PAGE_SIZE);
    expect(items).toHaveLength(FEED_PAGE_SIZE);
  });

  it('is twenty rows, which is the founder-facing number', async () => {
    // Written out rather than derived, so a change to the constant has to be a
    // deliberate change to this line as well.
    expect(FEED_PAGE_SIZE).toBe(20);
  });

  it('carries no keyset, because there is nothing before it', async () => {
    mockFeedRows = [event()];
    await load();

    expect(feedRead(0).or).toBeNull();
  });

  it('ends the feed when the server returns fewer rows than a page', async () => {
    // The true-end signal, and the only one there is: a short page means exhausted.
    mockFeedRows = [event(), event({ id: 'event-2' })];
    const { feed } = await open();

    expect(feed().hasNextPage).toBe(false);
  });

  it('offers a next page when the server filled the one it was asked for', async () => {
    mockFeedRows = fullPage();
    const { feed } = await open();

    expect(feed().hasNextPage).toBe(true);
  });
});

describe('the cursor into the next page', () => {
  /** Page one full, page two short, so the list settles after two reads. */
  const twoPages = () => {
    mockFeedQueue = [{ rows: fullPage() }, { rows: [nth(99)] }];
  };

  it('asks for rows strictly older than the last row of the page before it', async () => {
    twoPages();
    const { feed } = await open();
    const last = fullPage().at(-1) as { id: string; created_at: string };

    await act(async () => {
      await feed().fetchNextPage();
    });

    // The three branches of `(causal_at desc, causal_step desc, id asc)`, written out
    // because PostgREST has no row-value comparison. Read down them: an older instant;
    // or the same instant and an earlier step; or the same instant, the same step, and
    // a later id.
    expect(feedRead(1).or).toBe(
      [
        `causal_at.lt."${last.created_at}"`,
        `and(causal_at.eq."${last.created_at}",causal_step.lt.0)`,
        `and(causal_at.eq."${last.created_at}",causal_step.eq.0,id.gt.${last.id})`,
      ].join(','),
    );
  });

  it('tiebreaks on id, so rows sharing a timestamp cannot straddle the boundary', async () => {
    /**
     * The case this exists for: the three feed events one ranking writes share a
     * `causal_at` to the microsecond by construction (20260901000100). A cursor naming
     * only the timestamp would either re-serve all three or skip all three, depending on
     * which way the comparison went — so the last branch has to name the id.
     */
    const shared = '2026-08-20T12:00:00Z';
    mockFeedQueue = [
      {
        rows: Array.from({ length: FEED_PAGE_SIZE }, (_, i) =>
          nth(i, { created_at: shared, causal_at: shared, causal_step: 0 }),
        ),
      },
      { rows: [] },
    ];
    const { feed } = await open();
    await act(async () => {
      await feed().fetchNextPage();
    });

    const or = feedRead(1).or ?? '';
    expect(or).toContain(`causal_step.eq.0,id.gt.event-019`);
    // And never a bare timestamp comparison on its own, which would drop the other two.
    expect(or.split(',and(')).toHaveLength(3);
  });

  it('carries the step, so an award does not re-serve the ranking that earned it', async () => {
    // causal_step descends: 2 is the award, 0 the act. A page ending on the award has
    // to ask for the *lower* steps of the same instant next.
    const at = '2026-08-21T09:00:00Z';
    mockFeedQueue = [
      {
        rows: [
          ...Array.from({ length: FEED_PAGE_SIZE - 1 }, (_, i) => nth(i)),
          nth(50, { created_at: at, causal_at: at, causal_step: 2 }),
        ],
      },
      { rows: [] },
    ];
    const { feed } = await open();
    await act(async () => {
      await feed().fetchNextPage();
    });

    expect(feedRead(1).or).toContain(`and(causal_at.eq."${at}",causal_step.lt.2)`);
  });

  it('is taken from the raw row, not from the hydrated item', async () => {
    /**
     * `hydrate` drops a row whose actor cannot be named. A cursor built from the items
     * would therefore rewind past every dropped row, and the next page would re-serve
     * the tail of this one. The last row here is unnameable, so the two answers differ.
     */
    mockFeedQueue = [
      {
        rows: [
          ...Array.from({ length: FEED_PAGE_SIZE - 1 }, (_, i) => nth(i)),
          nth(77, { profiles: null }),
        ],
      },
      { rows: [] },
    ];
    const { feed } = await open();
    await act(async () => {
      await feed().fetchNextPage();
    });

    expect(feedRead(1).or).toContain('id.gt.event-077');
  });

  it('keeps asking past a page that hydrated away to nothing', async () => {
    /**
     * A page that comes back full and hydrates to zero items adds no rows, and a page
     * that adds no rows adds no scroll — so nothing on the screen would ever ask for the
     * one after it, and the feed would end on a lie. The read refills instead, bounded.
     */
    mockFeedQueue = [
      { rows: Array.from({ length: FEED_PAGE_SIZE }, (_, i) => nth(i, { profiles: null })) },
      { rows: [nth(200)] },
    ];
    const items = await load();

    expect(mockFeedReads).toHaveLength(2);
    expect(items.map((item) => item.id)).toEqual(['event-200']);
  });

  it('gives up rather than looping when every page hydrates away', async () => {
    mockFeedRows = Array.from({ length: FEED_PAGE_SIZE }, (_, i) => nth(i, { profiles: null }));
    const items = await load();

    expect(items).toHaveLength(0);
    // Bounded. A pathological account must not spin here.
    expect(mockFeedReads.length).toBeLessThanOrEqual(4);
  });
});

describe('what pagination must not change', () => {
  const secondRead = async () => {
    mockFeedQueue = [{ rows: fullPage() }, { rows: [] }];
    const { feed } = await open();
    await act(async () => {
      await feed().fetchNextPage();
    });
    return { first: feedRead(0), second: feedRead(1) };
  };

  it('reads the same columns on every page', async () => {
    // A projection that narrowed on page 2 would give the seam a different-looking row.
    const { first, second } = await secondRead();
    expect(second.select).toBe(first.select);
  });

  it('keeps the actor filter, which is what scopes the feed to the follow set', async () => {
    const { first, second } = await secondRead();
    expect(second.in.actor_id).toEqual(first.in.actor_id);
    expect(first.in.actor_id).toEqual(['user-1', 'friend']);
  });

  it('keeps the type filter, which is what excludes an ineligible event', async () => {
    /**
     * The eligibility rule is two-sided and neither side is here: `feed_events_read` is
     * `can_i_view(actor_id)`, so a private account, a block and a deleted row all come
     * back as no rows, from PostgreSQL, on every page alike — this client cannot weaken
     * that and does not try. What it *can* drop is the type allow-list, which is the one
     * eligibility filter written on this side. So: still there, and identical.
     */
    const { first, second } = await secondRead();
    expect(second.in.type).toEqual(first.in.type);
    expect(first.in.type).toEqual(expect.arrayContaining(['title_ranked', 'watchlist_added']));
  });

  it('asks for the same sort on every page', async () => {
    // Already asserted for a refetch above; asserted here for a *page*, which is the
    // case where a changed clause would silently skip and duplicate rows rather than
    // merely reorder them.
    orderCalls['feed_events'] = [];
    await secondRead();
    const clause = orderCalls['feed_events'] ?? [];

    expect(clause.slice(0, 3)).toEqual(clause.slice(3, 6));
  });

  it('leaves one person’s activity unpaginated, because it is not a feed', async () => {
    // `useActorActivity` reads five rows for a profile card. It goes through the same
    // reader, and it must not acquire a cursor — or a feed-sized limit — by doing so.
    mockFeedRows = [event()];
    const view = await renderHookWithProviders(() => useActorActivity('user-1'));
    await waitFor(() => expect(view.result.current.isPending).toBe(false));

    expect(feedRead(0).or).toBeNull();
    expect(feedRead(0).limit).toBe(5);
  });
});

describe('a page that fails', () => {
  it('keeps the rows already on screen', async () => {
    mockFeedQueue = [{ rows: fullPage() }, { error: { message: 'network' } }];
    const { feed, items } = await open();

    await act(async () => {
      await feed().fetchNextPage().catch(() => {});
    });
    await waitFor(() => expect(feed().isError).toBe(true));

    // The whole point: an error on page 2 is a footer, not an empty screen.
    expect(items()).toHaveLength(FEED_PAGE_SIZE);
  });

  it('loads on retry, from the cursor of the page that succeeded', async () => {
    mockFeedQueue = [{ rows: fullPage() }, { error: { message: 'network' } }];
    const { feed, items } = await open();
    await act(async () => {
      await feed().fetchNextPage().catch(() => {});
    });
    await waitFor(() => expect(feed().isError).toBe(true));

    mockFeedQueue = [{ rows: [nth(300)] }];
    await act(async () => {
      await feed().fetchNextPage();
    });

    await waitFor(() => expect(items()).toHaveLength(FEED_PAGE_SIZE + 1));
    // The retry asked the same question the failure did, and asked it once.
    expect(feedRead(2).or).toBe(feedRead(1).or);
    expect(feed().hasNextPage).toBe(false);
  });
});

describe('pages joined into a list', () => {
  it('keeps one copy of an activity that appears in two of them', async () => {
    /**
     * The keyset makes this impossible between *adjacent* pages. It is not impossible
     * across a refresh, where the first page is re-read and the next page is measured
     * from a boundary that has moved — and a duplicated React key is a rendering fault,
     * not merely a cosmetic one.
     */
    const items = feedItems([
      { items: [{ id: 'a' }, { id: 'b' }] as never, cursor: null },
      { items: [{ id: 'b' }, { id: 'c' }] as never, cursor: null },
    ]);

    expect(items.map((item) => item.id)).toEqual(['a', 'b', 'c']);
  });

  it('preserves the order the pages arrived in', async () => {
    const items = feedItems([
      { items: [{ id: 'a' }] as never, cursor: null },
      { items: [{ id: 'b' }] as never, cursor: null },
    ]);

    expect(items.map((item) => item.id)).toEqual(['a', 'b']);
  });

  it('is empty for a feed that has not loaded', async () => {
    expect(feedItems(undefined)).toEqual([]);
  });
});
