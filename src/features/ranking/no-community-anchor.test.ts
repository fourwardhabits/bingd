import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * **A comparison is between two titles, never between two numbers** (founder, 2026-09-13).
 *
 * The pass that put the bingd. community score on a Leaderboard board of its own — Top
 * Titles, removed again on 2026-09-14 so the Leaderboard is people competing and nothing
 * else — asked for a regression check that the number does not travel into the ranking
 * flow. The rule outlived the board: the score is still on the title page and on For You's
 * Top Rated walls, and the mechanic's value is still an unanchored preference:
 * "which of these two did you like more" answered with a 9.1 beside one of them is
 * answered by the 9.1. `RankingSheet.tsx` already states the rule for the reader's own
 * placements ("the opponent's position is never shown"); this makes it a property the suite
 * holds rather than a comment somebody has to find.
 *
 * Structural, on purpose. The ranking flow has a comparison card, a reveal and a long-press
 * recall sheet, and any of them could grow a score in a future pass through a hook, an RPC
 * name, or the component that draws the title page's scores. So every non-test source file
 * in the feature is read and none may name any of those. A deliberate need for one would
 * have to delete a line here, whose name says why it exists.
 */

const RANKING = join(__dirname);

const sources = readdirSync(RANKING)
  .filter((file) => /\.(ts|tsx)$/.test(file) && !/\.test\.(ts|tsx)$/.test(file))
  .map((file) => ({ file, text: readFileSync(join(RANKING, file), 'utf8') }));

/**
 * Every way a community or following number reaches a component in this app.
 *
 * Matched against code with comments stripped, so the prose that explains the rule — and
 * there is some, in `TitleRecallSheet.tsx` — cannot trip it.
 */
const FORBIDDEN = [
  /use-community-score/,
  /useCommunityScore/,
  /['"]community_score['"]/,
  /use-following-score/,
  /useFollowingScore/,
  /['"]following_score['"]/,
  /use-top-rated/,
  /useTopRated/,
  /['"]top_rated_titles['"]/,
  /ScoresSection/,
  /communityScore/,
];

const withoutComments = (text: string) =>
  text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

describe('the ranking flow shows no community number', () => {
  it('has source files to check', () => {
    // A guard that silently checked nothing would pass forever.
    expect(sources.map((source) => source.file)).toEqual(
      expect.arrayContaining(['RankingSheet.tsx', 'TitleRecallSheet.tsx']),
    );
  });

  it.each(FORBIDDEN.map((pattern) => [String(pattern), pattern] as const))(
    'no ranking source reaches %s',
    (_name, pattern) => {
      const hits = sources
        .filter((source) => pattern.test(withoutComments(source.text)))
        .map((source) => source.file);
      expect(hits).toEqual([]);
    },
  );

  it('fetches only a title and its artwork for a comparison card', () => {
    // The card's read is the narrowest thing it can be. Any widening — a score column, an
    // embed of an aggregate — changes this string first. `kind` joined it on 2026-09-11
    // with the comparison memory aids: it is what `comparison_info_opened` reports as
    // `media_kind`, a property of the title rather than a number about it.
    const sheet = sources.find((source) => source.file === 'RankingSheet.tsx');
    expect(sheet?.text).toContain(".select('id, kind, title, poster_path')");
  });
});
