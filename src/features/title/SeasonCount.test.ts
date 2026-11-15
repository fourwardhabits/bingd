import { seasonCountLabel } from './season-count';

/**
 * **A whole show's length is its count of seasons** (visual refine, 2026-11-12).
 *
 * The pure rule first; the screen itself, on both layouts, is pinned in
 * `TitleScreen.test.tsx` under "a series' count of seasons".
 */
describe('seasonCountLabel', () => {
  const rows = (...numbers: number[]) => numbers.map((season_number) => ({ season_number }));
  const answered = (...numbers: number[]) => ({ isSuccess: true, data: rows(...numbers) });

  it('says 1 season, singular', () => {
    expect(seasonCountLabel(answered(1))).toBe('1 season');
  });

  it('says 3 seasons, plural', () => {
    expect(seasonCountLabel(answered(1, 2, 3))).toBe('3 seasons');
  });

  it('does not count Specials (Season 0)', () => {
    expect(seasonCountLabel(answered(0, 1, 2))).toBe('2 seasons');
  });

  it('says nothing for a list of only Specials', () => {
    expect(seasonCountLabel(answered(0))).toBeNull();
  });

  it('says nothing for an empty list, never 0 seasons', () => {
    expect(seasonCountLabel(answered())).toBeNull();
  });

  it('says nothing while the list is loading', () => {
    expect(seasonCountLabel({ isSuccess: false, data: undefined })).toBeNull();
  });

  it('says nothing once the list has failed, even with rows from before', () => {
    // React Query keeps the last data on a failed refetch; an errored list is not an answer.
    expect(seasonCountLabel({ isSuccess: false, data: rows(1, 2) })).toBeNull();
  });

  it('never prints a zero', () => {
    for (const input of [answered(), answered(0), answered(0, 0), { isSuccess: false }]) {
      expect(seasonCountLabel(input) ?? '').not.toMatch(/^0 /);
    }
  });
});
