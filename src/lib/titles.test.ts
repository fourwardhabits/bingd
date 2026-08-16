import { fullTitle, isSameEntity } from './titles';

/**
 * "Suraj Kandukuri ranked Season 2" is the string that prompted this module. The
 * cases below are the ones where getting it wrong is visible: a season away from its
 * series, a limited series whose one season carries the show's name, and a catalogue
 * row that has a parent id but no parent title yet because the enrichment has not run.
 */
describe('fullTitle', () => {
  it('names a season with its series wherever the series is not already on screen', () => {
    expect(
      fullTitle({ kind: 'season', title: 'Season 2', seriesTitle: 'Parks and Recreation' }),
    ).toBe('Parks and Recreation — Season 2');
  });

  it('drops the series only where the caller says it is already visible', () => {
    const season = { kind: 'season' as const, title: 'Season 2', seriesTitle: 'Parks and Recreation' };
    expect(fullTitle(season, { parentIsVisible: true })).toBe('Season 2');
    // The long form is what you get by default, because the short form's failure is
    // an activity item about nothing and the long form's is mild repetition.
    expect(fullTitle(season)).toContain('Parks and Recreation');
  });

  it('leaves a movie and a series alone', () => {
    expect(fullTitle({ kind: 'movie', title: 'Sinners' })).toBe('Sinners');
    expect(fullTitle({ kind: 'series', title: 'Severance' })).toBe('Severance');
  });

  it('does not say the show twice when the season is already named after it', () => {
    expect(fullTitle({ kind: 'season', title: 'Chernobyl', seriesTitle: 'Chernobyl' })).toBe(
      'Chernobyl',
    );
    expect(
      fullTitle({ kind: 'season', title: 'Chernobyl: Season 1', seriesTitle: 'Chernobyl' }),
    ).toBe('Chernobyl: Season 1');
  });

  it('falls back to the season alone when the series title is not loaded', () => {
    expect(fullTitle({ kind: 'season', title: 'Season 2', seriesTitle: null })).toBe('Season 2');
    expect(fullTitle({ kind: 'season', title: 'Season 2' })).toBe('Season 2');
  });

  it('returns nothing rather than an empty name', () => {
    expect(fullTitle({ kind: 'movie', title: null })).toBeNull();
    expect(fullTitle({ kind: 'movie', title: '   ' })).toBeNull();
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
