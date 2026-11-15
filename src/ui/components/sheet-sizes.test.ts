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

/**
 * Every `<Sheet ...>` opening tag's props in a file.
 *
 * Parsed rather than matched with `/<Sheet\b([\s\S]*?)>/` (design-system v3 A.2 #2): the
 * lazy regex stopped at the `>` of an `=>` inside `onClose={() => ...}`, so everything after
 * an arrow prop (a `size=` included) was never read and `not.toMatch(/size=/)` passed
 * vacuously. This walks each tag, skipping comments, quoted strings and `{...}` expressions
 * (nested braces, `=>`, `>` comparisons), and stops at the first `>` outside all of them.
 * A `<Sheet` that is only mentioned in a comment is not a tag and is skipped.
 */
const sheetTags = (source: string) => {
  // Where block comments (`/* */`, `/** */`, `{/* */}`) sit, so a mention inside one is skipped.
  const comments: [number, number][] = [];
  for (const block of source.matchAll(/\/\*[\s\S]*?\*\//g)) {
    comments.push([block.index!, block.index! + block[0].length]);
  }
  const inComment = (at: number) => {
    if (comments.some(([from, to]) => at >= from && at < to)) return true;
    const line = source.slice(source.lastIndexOf('\n', at - 1) + 1, at);
    return /^\s*\/\//.test(line) || line.endsWith('`');
  };

  const tags: string[] = [];
  for (const match of source.matchAll(/<Sheet\b/g)) {
    if (inComment(match.index!)) continue;
    const start = match.index! + match[0].length;
    let depth = 0;
    let quote: string | null = null;
    let end = -1;
    for (let at = start; at < source.length; at += 1) {
      const char = source[at]!;
      if (quote) {
        if (char === '\\') at += 1;
        else if (char === quote) quote = null;
      } else if (source.startsWith('/*', at)) {
        at = source.indexOf('*/', at + 2) + 1;
      } else if (source.startsWith('//', at)) {
        at = source.indexOf('\n', at);
      } else if (char === '"' || char === "'" || char === '`') {
        quote = char;
      } else if (char === '{') {
        depth += 1;
      } else if (char === '}') {
        depth -= 1;
      } else if (char === '>' && depth === 0) {
        end = at;
        break;
      }
    }
    if (end === -1) throw new Error(`Unclosed <Sheet tag at ${match.index}`);
    tags.push(source.slice(start, end).replace(/\/$/, ''));
  }
  return tags;
};

describe('sheetTags', () => {
  it('reads past an arrow prop to a size= after it', () => {
    const [tag] = sheetTags('<Sheet visible onClose={() => setOpen(false)} size="standard">');
    expect(tag).toMatch(/size="standard"/);
    // The old lazy regex stopped at the arrow's `>` and never saw it.
    expect(
      '<Sheet visible onClose={() => setOpen(false)} size="standard">'.match(
        /<Sheet\b([\s\S]*?)>/,
      )![1],
    ).not.toMatch(/size=/);
  });

  it('skips `>` in nested braces and strings, and reads every tag in a file', () => {
    const tags = sheetTags(`
      <Sheet visible={a > b} label="a > b" onClose={() => { if (x) { go(); } }} density="dense">
        <SheetRow icon="x" label="y" />
      </Sheet>
      <Sheet visible onClose={close} size="standard" />
    `);
    expect(tags).toHaveLength(2);
    expect(tags[0]).toMatch(/density="dense"/);
    expect(tags[1]).toMatch(/size="standard"/);
  });

  it('skips comments inside a tag and a <Sheet only mentioned in a comment', () => {
    const tags = sheetTags(`
      // A \`<Sheet>\` named in a line comment, and one in \`<Sheet size="standard">\` prose.
      /* <Sheet size="standard"> in a block comment */
      <Sheet
        visible
        /** The modal's children stay mounted; a \`<Modal>\` mid-dismissal. */
        onClose={visible ? onClose : noop}
        label="How was it?"
      >
    `);
    expect(tags).toHaveLength(1);
    expect(tags[0]).toMatch(/label="How was it\?"/);
    expect(tags[0]).not.toMatch(/size=/);
  });
});

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
