import { tasteMatchBadge, tasteMatchCopy, tasteMatchState, type TasteMatch } from './use-taste-match';

/**
 * The Match line's decision, without a render.
 *
 * The founder's report was that Match is missing on other people's profiles, and the
 * cause was that the old surface had exactly two outcomes — a percentage, or silence.
 * Silence covered four different situations and explained none of them, and on a friend
 * beta it was the answer almost every time: `taste.min_common` is five *exactly shared*
 * rankings, both accounts having ranked the same film or the same season.
 *
 * So the states are four now, and the two that are not a number are the ones worth
 * pinning: telling somebody to rank more when ranking more cannot help is worse than
 * saying nothing, and it is the mistake this function exists to avoid making.
 */

const match = (over: Partial<TasteMatch> = {}): TasteMatch => ({
  score: null,
  commonCount: 0,
  minCommon: 5,
  ...over,
});

describe('tasteMatchState', () => {
  it('shows the score when there is one', () => {
    expect(
      tasteMatchState({
        match: match({ score: 87, commonCount: 20 }),
        isSelf: false,
        viewerRanked: 40,
        subjectRanked: 40,
      }),
    ).toEqual({ kind: 'match', label: '87% Match' });
  });

  /**
   * The one branch where "rank more" is true rather than encouraging: the other account
   * has plenty ranked, so every shared title still missing is one the reader has not
   * ranked yet.
   */
  it('asks the viewer to rank more only when the viewer is the one short', () => {
    expect(
      tasteMatchState({
        match: match({ commonCount: 1 }),
        isSelf: false,
        viewerRanked: 2,
        subjectRanked: 30,
      }),
    ).toEqual({ kind: 'rank-more', label: 'Rank more to see Match' });
  });

  /**
   * And the branch it must not say it in. Nothing the viewer ranks reaches five shared
   * titles with somebody who has ranked three — the advice would be false, and acting on
   * it would not change the screen.
   */
  it('does not ask the viewer to rank more when the other account is short', () => {
    expect(
      tasteMatchState({
        match: match({ commonCount: 2 }),
        isSelf: false,
        viewerRanked: 2,
        subjectRanked: 3,
      }),
    ).toEqual({ kind: 'too-few', label: 'Not enough shared taste yet' });
  });

  it('blames neither side when both have ranked plenty and simply have not overlapped', () => {
    expect(
      tasteMatchState({
        match: match({ commonCount: 3 }),
        isSelf: false,
        viewerRanked: 200,
        subjectRanked: 200,
      }),
    ).toEqual({ kind: 'too-few', label: 'Not enough shared taste yet' });
  });

  /**
   * Nothing at all while an answer is outstanding, which covers three genuinely
   * different absences: the RPC has not replied, the viewer's own collection has not
   * loaded, and the subject's counts are not visible on this surface at all.
   *
   * A line that says "Rank more to see Match" and turns into 84% a second later is worse
   * than one that arrives once — and the third case is a private account, where the
   * counts are withheld deliberately.
   */
  it.each([
    ['the match is still in flight', { match: undefined, viewerRanked: 10, subjectRanked: 10 }],
    ['the viewer’s own collection has not loaded', { match: match(), viewerRanked: undefined, subjectRanked: 10 }],
    ['the subject’s counts are not visible', { match: match(), viewerRanked: 10, subjectRanked: undefined }],
  ])('says nothing while %s', (_why, over) => {
    expect(tasteMatchState({ isSelf: false, ...over } as Parameters<typeof tasteMatchState>[0])).toBeNull();
  });

  it('is absent on the reader’s own profile even with a perfect score', () => {
    // A 100% match with your own catalogue is a tautology. `taste_match` refuses the
    // self case as well; this is the display half of the same decision.
    expect(
      tasteMatchState({
        match: match({ score: 100, commonCount: 40 }),
        isSelf: true,
        viewerRanked: 40,
        subjectRanked: 40,
      }),
    ).toBeNull();
  });

  /**
   * The founder ruled this out by name, and it is the one failure that would be visible
   * to every beta reader at once: no `TBD`, and no percentage the app does not have.
   */
  it('never produces a placeholder percentage', () => {
    for (const viewerRanked of [0, 4, 5, 100]) {
      for (const subjectRanked of [0, 4, 5, 100]) {
        const state = tasteMatchState({
          match: match({ commonCount: 2 }),
          isSelf: false,
          viewerRanked,
          subjectRanked,
        });
        expect(state?.label).not.toMatch(/%/);
        expect(state?.label).not.toMatch(/TBD/i);
      }
    }
  });
});

/**
 * The two older shapes, which the profiles no longer use. Kept under test because the
 * rule they encode — a number or nothing, never `0%` — is the one this feature cannot
 * afford to lose to a future edit.
 */
describe('the compact forms', () => {
  it('gives a badge only when there is a number', () => {
    expect(tasteMatchBadge(match({ score: 84 }))).toEqual({ value: '84%', label: 'Match' });
    expect(tasteMatchBadge(match({ commonCount: 3 }))).toBeNull();
    expect(tasteMatchBadge(undefined)).toBeNull();
  });

  it('still explains the shortfall in the long form, with the count', () => {
    expect(tasteMatchCopy(match({ commonCount: 3 }))).toEqual({
      headline: 'Not enough overlap yet',
      detail: '3 titles in common — 5 needed.',
    });
  });
});
