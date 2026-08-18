import { compactName, compactTitle, fullTitle, isSameEntity } from './titles';

/**
 * "Suraj Kandukuri ranked Season 2" is the string that prompted this module. The
 * cases below are the ones where getting it wrong is visible: a season away from its
 * series, a limited series whose one season carries the show's name, and a catalogue
 * row that has a parent id but no parent title yet because the enrichment has not run.
 */
describe('compactName', () => {
  it('names a season with its series wherever the series is not already on screen', () => {
    expect(
      compactName({
        kind: 'season',
        title: 'Season 1',
        seriesTitle: 'The Last of Us',
        seasonNumber: 1,
      }),
    ).toBe('The Last of Us, S1');
  });

  it('has no em dash anywhere in it', () => {
    const name = compactName({
      kind: 'season',
      title: 'Season 2',
      seriesTitle: 'Parks and Recreation',
      seasonNumber: 2,
    });
    expect(name).toBe('Parks and Recreation, S2');
    expect(name).not.toContain('—');
  });

  it('recovers the season number from the title when the read did not select it', () => {
    expect(compactName({ kind: 'season', title: 'Season 4', seriesTitle: 'Fargo' })).toBe(
      'Fargo, S4',
    );
  });

  it('joins with the season own words when there is no number to recover', () => {
    expect(
      compactName({ kind: 'season', title: 'Specials', seriesTitle: 'Doctor Who' }),
    ).toBe('Doctor Who, Specials');
  });

  it('drops the series only where the caller says it is already visible', () => {
    const season = {
      kind: 'season' as const,
      title: 'Season 2',
      seriesTitle: 'Parks and Recreation',
      seasonNumber: 2,
    };
    expect(compactName(season, { parentIsVisible: true })).toBe('Season 2');
    // The long form is what you get by default, because the short form's failure is
    // an activity item about nothing and the long form's is mild repetition.
    expect(compactName(season)).toContain('Parks and Recreation');
  });

  it('leaves a movie and a series alone', () => {
    expect(compactName({ kind: 'movie', title: 'Sinners' })).toBe('Sinners');
    expect(compactName({ kind: 'series', title: 'Severance' })).toBe('Severance');
  });

  it('does not say the show twice when the season is already named after it', () => {
    expect(
      compactName({ kind: 'season', title: 'Chernobyl', seriesTitle: 'Chernobyl', seasonNumber: 1 }),
    ).toBe('Chernobyl');
    expect(
      compactName({
        kind: 'season',
        title: 'Chernobyl: Season 1',
        seriesTitle: 'Chernobyl',
        seasonNumber: 1,
      }),
    ).toBe('Chernobyl: Season 1');
  });

  it('falls back to the season alone when the series title is not loaded', () => {
    expect(compactName({ kind: 'season', title: 'Season 2', seriesTitle: null })).toBe('Season 2');
    expect(compactName({ kind: 'season', title: 'Season 2' })).toBe('Season 2');
  });

  it('returns nothing rather than an empty name', () => {
    expect(compactName({ kind: 'movie', title: null })).toBeNull();
    expect(compactName({ kind: 'movie', title: '   ' })).toBeNull();
  });

  it('is what the old name still resolves to', () => {
    expect(fullTitle).toBe(compactName);
  });
});

/**
 * The founder's standard, in full: `The Last of Us, S1 (2023)`. This is the form for
 * surfaces that print one string; a row with its own year column uses `compactName`
 * and prints the year itself so it can be the quieter of the two.
 */
describe('compactTitle', () => {
  it('is the founder standard', () => {
    expect(
      compactTitle({
        kind: 'season',
        title: 'Season 1',
        seriesTitle: 'The Last of Us',
        seasonNumber: 1,
        year: 2023,
      }),
    ).toBe('The Last of Us, S1 (2023)');
  });

  it('takes the year from a date string as readily as from a number', () => {
    expect(compactTitle({ kind: 'movie', title: 'Sinners', year: '2025-04-18' })).toBe(
      'Sinners (2025)',
    );
  });

  it('omits the parenthesis rather than printing an empty one', () => {
    expect(compactTitle({ kind: 'movie', title: 'Sinners', year: null })).toBe('Sinners');
    expect(compactTitle({ kind: 'movie', title: 'Sinners' })).toBe('Sinners');
  });

  it('returns nothing when there is no name, year or not', () => {
    expect(compactTitle({ kind: 'movie', title: null, year: 2025 })).toBeNull();
  });
});

describe('isSameEntity', () => {
  it('is identity, so a season never stands in for its series or its siblings', () => {
    expect(isSameEntity('season-1', 'season-1')).toBe(true);
    expect(isSameEntity('season-1', 'season-2')).toBe(false);
    expect(isSameEntity('season-1', 'series-1')).toBe(false);
  });

  it('is false when either side is missing, rather than true by vacuity', () => {
    expect(isSameEntity(null, null)).toBe(false);
    expect(isSameEntity(undefined, 'season-1')).toBe(false);
    expect(isSameEntity('season-1', null)).toBe(false);
  });
});
