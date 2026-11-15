import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * **Which sheets are the standard browsing size** (FU1113-B, B8), read from the source so
 * a sheet cannot drift in or out of the standard size without this list changing with it.
 */
const root = join(__dirname, '../../..');
const read = (path: string) => readFileSync(join(root, path), 'utf8');

/** Full-size browsing lists: the standard 80% sheet with a pinned Close. */
const STANDARD = [
  'src/features/profile/RankedTitlesSheet.tsx',
  'src/features/profile/FollowListSheet.tsx',
  'src/features/awards/AwardsSheet.tsx',
  'src/features/recommendations/GroupPicksSheet.tsx',
  'src/features/title/FollowingRatingsSheet.tsx',
  'src/features/recommendations/RecommendersSheet.tsx',
  'src/features/goals/GoalTitlesSheet.tsx',
];

/**
 * Confirmations, menus, inline editors, the log and ranking flows, Report and small
 * pickers: sized to their content, exactly as before. Their `<Sheet>` props carry neither
 * `size` nor `density`.
 */
const CONTENT = [
  'src/features/collection/LogSheet.tsx',
  'src/features/ranking/RankingSheet.tsx',
  'src/features/moderation/ReportSheet.tsx',
  'src/features/profile/ProfileMenu.tsx',
  'src/features/profile/MatchExplainer.tsx',
  'src/features/lists/NewListSheet.tsx',
  'src/features/lists/EditListSheet.tsx',
  'src/features/lists/AddToListSheet.tsx',
  'src/features/goals/GoalSheet.tsx',
  'src/features/onboarding/TasteBucketSheet.tsx',
  'src/features/collection/CollectionFilterSheet.tsx',
  'src/features/watch-history/LogAnotherWatchSheet.tsx',
  'src/features/share/FirstFiveShareSheet.tsx',
];

/** Every `<Sheet ...>` opening tag's props in a file. */
const sheetTags = (source: string) =>
  [...source.matchAll(/<Sheet\b([\s\S]*?)>/g)].map((match) => match[1]);

describe('sheet sizes', () => {
  it.each(STANDARD)('%s is the standard size, with a pinned DismissFooter', (path) => {
    const tags = sheetTags(read(path));
    expect(tags.length).toBeGreaterThan(0);
    for (const tag of tags) {
      expect(tag).toMatch(/size="standard"/);
      expect(tag).toMatch(/footer=/);
    }
    expect(read(path)).toMatch(/DismissFooter/);
  });

  it.each(CONTENT)('%s keeps its content-sized sheet', (path) => {
    const tags = sheetTags(read(path));
    expect(tags.length).toBeGreaterThan(0);
    for (const tag of tags) {
      expect(tag).not.toMatch(/size=/);
      expect(tag).not.toMatch(/density=/);
    }
  });
});
