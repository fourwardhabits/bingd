import { tasteMatchBadge, tasteMatchLine, type TasteMatch } from './use-taste-match';

/**
 * The Match line's decision, without a render.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS FILE PINS, AND WHAT IT USED TO
 *
 * It used to pin four states, three of which were sentences: a percentage, "Rank more
 * to see Match", "Not enough shared taste yet", and silence. The founder's 2026-08-28 §2
 * replaces the sentences with one compact form carrying the evidence:
 *
 *     89% Match · 42 shared
 *     Match TBD · 3 shared
 *
 * So two things move and one does not.
 *
 * **The shared count is the evidence Match was measured over, exactly.** It is
 * `common_count` from the same `taste_match` row the percentage came from — one query,
 * one definition — so the assertion that matters is that the number in the label is that
 * number and not a count of anything else the profile has on screen. There is no
 * arithmetic in this module for a test to check; the property under test is that none
 * was introduced.
 *
 * **`Match TBD` is now permitted, and the old rule it appears to break was about
 * something else.** The rule was: never invent a percentage. `0% Match` on a pair with
 * no evidence is a lie in the units of the answer; `Match TBD` says there is no number
 * yet, in different units, which is true. The no-invented-percentage assertion is kept
 * and strengthened rather than dropped, because it is the one that was actually
 * protecting anything.
 *
 * **The rank-more distinction survives, in the sheet.** Telling somebody to rank more
 * when ranking more cannot help is the mistake this module exists to avoid, and it is
 * still a mistake — it has just moved off the profile, where §3 says the treatment stays
 * compact, and into `explanation.nudge`. Those branches are tested here as hard as they
 * were when they were the label.
 */

const match = (over: Partial<TasteMatch> = {}): TasteMatch => ({
  score: null,
  commonCount: 0,
  minCommon: 5,
  ...over,
});

const line = (over: Partial<Parameters<typeof tasteMatchLine>[0]> = {}) =>
  tasteMatchLine({
    match: match(),
    isSelf: false,
    viewerRanked: 40,
    subjectRanked: 40,
    name: 'Ravi',
    ...over,
  });

describe('the compact line', () => {
  it('states the score and the evidence together', () => {
    expect(line({ match: match({ score: 89, commonCount: 42 }) })).toMatchObject({
      kind: 'match',
      label: '89% Match · 42 shared',
    });
  });

  it('says TBD, with the count, when there is no score yet', () => {
    expect(
      line({ match: match({ commonCount: 3 }), viewerRanked: 3, subjectRanked: 30 }),
    ).toMatchObject({ kind: 'tbd', label: 'Match TBD · 3 shared' });
  });

  /**
   * The count is the *evidence population*, so a pair with no overlap says zero rather
   * than omitting the half of the line that explains the absence. "Match TBD" alone
   * would leave a reader unable to tell "nearly there" from "nothing in common".
   */
  it('says zero rather than dropping the count', () => {
    expect(line({ match: match({ commonCount: 0 }) })?.label).toBe('Match TBD · 0 shared');
  });

  it('does not pluralise, because shared is not a noun here', () => {
    expect(line({ match: match({ score: 70, commonCount: 1 }) })?.label).toBe(
      '70% Match · 1 shared',
    );
  });

  /**
   * The count in the label is whatever `taste_match` returned and nothing else.
   *
   * This is founder §2's requirement — the shared count must come from the same
   * population as the Match — expressed as the only thing a client-side test can check:
   * that the number is passed through rather than derived. A future edit computing it
   * from `viewerRanked`/`subjectRanked`, or capping it, or rounding it, fails here.
   */
  it('passes the server’s count through untouched, whatever the catalogue sizes say', () => {
    for (const [viewerRanked, subjectRanked] of [
      [0, 0],
      [1, 1000],
      [1000, 1],
      [7, 7],
    ]) {
      expect(line({ match: match({ score: 61, commonCount: 42 }), viewerRanked, subjectRanked })?.label).toBe(
        '61% Match · 42 shared',
      );
    }
  });
});

describe('the explanation behind the line', () => {
  it('names the person, in both paragraphs', () => {
    const explanation = line({ match: match({ score: 89, commonCount: 42 }) })?.explanation;

    expect(explanation?.match).toBe(
      "How similarly you and Ravi rate titles you've both ranked. " +
        'More shared titles makes the Match more reliable.',
    );
    expect(explanation?.shared).toBe('Titles you and Ravi have both ranked.');
  });

  /**
   * The founder ruled all four out by name. A reader deciding whether to trust a
   * recommendation needs to know what was measured, not how — and this is the assertion
   * that stops a future edit "improving" the copy by explaining the method.
   */
  it('contains no formula and no jargon', () => {
    const explanation = line({ match: match({ score: 89, commonCount: 42 }) })?.explanation;
    const prose = `${explanation?.match} ${explanation?.shared} ${explanation?.nudge ?? ''}`;

    for (const word of [/spearman/i, /shrink/i, /correlat/i, /rank agreement/i, /proximity/i]) {
      expect(prose).not.toMatch(word);
    }
  });

  /**
   * The one branch where "rank more" is true rather than merely encouraging: the other
   * account has plenty ranked, so every shared title still missing is one the reader has
   * not ranked yet.
   */
  it('nudges the viewer only when the viewer is the one short', () => {
    expect(
      line({ match: match({ commonCount: 1 }), viewerRanked: 2, subjectRanked: 30 })?.explanation
        .nudge,
    ).toBe('Rank a few more titles and this will fill in.');
  });

  /**
   * And the branch it must not nudge in. Nothing the viewer ranks reaches five shared
   * titles with somebody who has ranked three — the advice would be false, and acting on
   * it would not change the screen.
   */
  it('does not nudge when the other account is the short side', () => {
    expect(
      line({ match: match({ commonCount: 2 }), viewerRanked: 2, subjectRanked: 3 })?.explanation
        .nudge,
    ).toBeNull();
  });

  it('does not nudge when both have ranked plenty and simply have not overlapped', () => {
    expect(
      line({ match: match({ commonCount: 3 }), viewerRanked: 200, subjectRanked: 200 })
        ?.explanation.nudge,
    ).toBeNull();
  });

  it('does not nudge once there is a score, however thin', () => {
    expect(
      line({ match: match({ score: 62, commonCount: 5 }), viewerRanked: 5, subjectRanked: 300 })
        ?.explanation.nudge,
    ).toBeNull();
  });
});

describe('when the line says nothing at all', () => {
  /**
   * Three genuinely different absences, deliberately collapsed to one render.
   *
   * A line that says something and turns into `89% Match · 42 shared` a second later is
   * worse than one that arrives once — and the third case is a private account, where
   * the counts are withheld on purpose (§25).
   */
  it.each([
    ['the match is still in flight', { match: undefined }],
    ['the viewer’s own collection has not loaded', { viewerRanked: undefined }],
    ['the subject’s counts are not visible', { subjectRanked: undefined }],
  ])('says nothing while %s', (_why, over) => {
    expect(line(over as Parameters<typeof line>[0])).toBeNull();
  });

  it('is absent on the reader’s own profile even with a perfect score', () => {
    // A 100% match with your own catalogue is a tautology. `taste_match` refuses the
    // self case as well; this is the display half of the same decision.
    expect(line({ match: match({ score: 100, commonCount: 40 }), isSelf: true })).toBeNull();
  });
});

/**
 * The rule that did not change, and the reason this describe survives the rewrite.
 *
 * No percentage the app does not have. `Match TBD` is allowed *because* it is not one:
 * it is in a different unit, so a reader cannot mistake it for a low score. The sweep
 * below is over every combination of catalogue sizes precisely because the old bug it
 * guards against — a placeholder appearing in one branch nobody thought about — was
 * found by a branch nobody thought about.
 */
describe('no invented number, ever', () => {
  it('never puts a percentage on a pair with no score', () => {
    for (const viewerRanked of [0, 4, 5, 100]) {
      for (const subjectRanked of [0, 4, 5, 100]) {
        const result = line({ match: match({ commonCount: 2 }), viewerRanked, subjectRanked });
        expect(result?.label).not.toMatch(/%/);
        expect(result?.kind).toBe('tbd');
      }
    }
  });

  it('never says 0%', () => {
    expect(line({ match: match({ commonCount: 0 }) })?.label).not.toMatch(/0%/);
  });
});

/**
 * The badge under the avatar, which neither profile draws. Kept under test because the
 * rule it encodes — a number or nothing, never `0%` — is the one this feature cannot
 * afford to lose to a future edit, whatever shape the line itself takes.
 */
describe('the badge form', () => {
  it('gives a badge only when there is a number', () => {
    expect(tasteMatchBadge(match({ score: 84 }))).toEqual({ value: '84%', label: 'Match' });
    expect(tasteMatchBadge(match({ commonCount: 3 }))).toBeNull();
    expect(tasteMatchBadge(undefined)).toBeNull();
  });
});
