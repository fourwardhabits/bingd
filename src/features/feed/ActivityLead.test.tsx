import { render } from '@testing-library/react-native';

import { badgeFor } from '@/features/awards/badges';

import { activityLead } from './ActivityLead';
import type { FeedItem } from './use-feed';

/**
 * What leads an activity row, and the founder's physical-QA finding that produced it.
 *
 * The same earned award wore two faces: "Suraj Kandukuri earned the Spark award" led
 * with the Spark glyph in the Feed and with a beige tile reading **S** on the profile.
 * The data was identical — both surfaces read the same `FeedItem` from the same
 * `activityPage` call — and only the feed passed `lead`, so `ActivityRow` fell back to a
 * poster that does not exist and `MissingArtwork` drew the initial of the award's name.
 *
 * These assertions are about the resolver. The two screen suites assert that the Feed
 * and the profile actually *call* it, which together is the regression: one function
 * decides, and every surface asks it.
 */

const base: FeedItem = {
  id: 'event-1',
  type: 'title_ranked',
  actorId: 'user-1',
  actorUsername: 'sai',
  actorName: 'Suraj Kandukuri',
  actorAvatarUri: null,
  mediaItemId: 'film-1',
  kind: 'movie',
  title: 'Inception',
  year: 2010,
  posterPath: '/p.jpg',
  genres: [],
  certification: null,
  runtimeMinutes: null,
  episodeCount: null,
  score: null,
  bucket: null,
  note: null,
  companions: [],
  createdAt: '2026-09-01T00:00:00Z',
  award: null,
  goal: null,
} as unknown as FeedItem;

const awardEvent = (key: string, tierKey: string): FeedItem =>
  ({
    ...base,
    type: 'award_earned',
    mediaItemId: null,
    posterPath: null,
    title: 'Spark',
    award: { key, tierKey, name: 'Spark', achievement: 'Watched 25 action titles' },
  }) as unknown as FeedItem;

/** Every string the lead renders, which for an emoji badge is the glyph itself. */
const glyphs = (node: unknown): string[] => {
  if (typeof node === 'string') return [node];
  if (Array.isArray(node)) return node.flatMap(glyphs);
  if (node && typeof node === 'object')
    return glyphs((node as { children?: unknown }).children);
  return [];
};

describe('an award row', () => {
  it('leads with the award badge rather than with nothing', () => {
    expect(activityLead(awardEvent('boom-club', 'spark'))).not.toBeUndefined();
  });

  it('draws the canonical artwork for that exact tier', async () => {
    // Spark is `boom-club-spark`, which is one of the thirty tiers still standing in
    // with an emoji. The point is not which glyph it is — it is that the row asks
    // `badges.ts` rather than manufacturing something from the award's name.
    const canonical = badgeFor('boom-club', 'spark');
    expect(canonical).toEqual({ kind: 'emoji', emoji: '✨' });

    const view = await render(<>{activityLead(awardEvent('boom-club', 'spark'))}</>);
    expect(glyphs(view.toJSON())).toContain('✨');
  });

  it('never falls back to the first letter of the award name', async () => {
    // The founder's screenshot, as an assertion. "S" for Spark is `MissingArtwork`
    // doing its job on a row that has no poster and never will.
    const view = await render(<>{activityLead(awardEvent('boom-club', 'spark'))}</>);
    expect(glyphs(view.toJSON())).not.toContain('S');
  });

  it('distinguishes tiers of the same track, so a Gold is not drawn as a Bronze', async () => {
    const bronze = badgeFor('movie-muncher', 'bronze');
    const gold = badgeFor('movie-muncher', 'gold');

    expect(bronze).not.toEqual(gold);
  });

  it('survives an award key this bundle has never heard of', async () => {
    // A track added by a future migration, on an older client. `badgeFor` falls back to
    // a neutral medal rather than throwing, which is the right degradation for a client
    // behind the database — and is still not an initial.
    const view = await render(
      <>{activityLead(awardEvent('a-track-from-the-future', 'tier-1'))}</>,
    );
    expect(glyphs(view.toJSON())).not.toContain('A');
  });
});

describe('every other kind of row', () => {
  it('leads a goal row with the goal mark', () => {
    const goal = { ...base, type: 'goal_completed', goal: { category: 'movies', target: 25 } };
    expect(activityLead(goal as unknown as FeedItem)).not.toBeUndefined();
  });

  it('leaves an ordinary row to its poster', () => {
    // `undefined`, so `ActivityRow`'s `lead ?? <Poster …>` reaches the poster. A ranking
    // has artwork and the artwork is the right thing to lead with.
    expect(activityLead(base)).toBeUndefined();
  });
});
