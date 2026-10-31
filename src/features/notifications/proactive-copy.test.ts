import { availablePhrase, clusterPhrase, opensPhrase, premiereName } from './use-notifications';

/**
 * The phrases the proactive inbox rows are built from (20261028000100). The push
 * says the same thing (`push-sender/copy.ts`, tested in Deno), so a reader who taps the
 * lock screen and then opens the inbox reads one description of one event.
 */
describe('clusterPhrase', () => {
  const cluster = (count: number, ...names: string[]) => ({
    count,
    actors: names.map((name) => ({ username: name.toLowerCase(), name, avatarUri: null })),
  });

  it('names one, two, and two plus the rest', () => {
    expect(clusterPhrase(cluster(1, 'Ravi'))).toBe('Ravi');
    expect(clusterPhrase(cluster(2, 'Ravi', 'Eric'))).toBe('Ravi and Eric');
    expect(clusterPhrase(cluster(3, 'Ravi', 'Eric', 'Mo'))).toBe('Ravi, Eric and 1 other');
    expect(clusterPhrase(cluster(6, 'Ravi', 'Eric', 'Mo'))).toBe('Ravi, Eric and 4 others');
  });

  it('says nothing about an empty cluster, and counts when names are missing', () => {
    expect(clusterPhrase(null)).toBeNull();
    expect(clusterPhrase(cluster(0))).toBeNull();
    expect(clusterPhrase(cluster(3))).toBe('3 friends');
    expect(clusterPhrase(cluster(2, 'Ravi'))).toBe('Ravi and 1 other');
  });
});

describe('opensPhrase', () => {
  // 2031-05-16 is a Friday.
  it('says when, before the day, and that it opened, on or after it', () => {
    expect(opensPhrase('2031-05-16', new Date(2031, 4, 9))).toBe('Opens Fri, May 16');
    expect(opensPhrase('2031-05-16', new Date(2031, 4, 16))).toBe('Opened May 16');
    expect(opensPhrase('2031-05-16', new Date(2031, 5, 1))).toBe('Opened May 16');
  });

  it('refuses anything that is not a calendar date', () => {
    expect(opensPhrase(null)).toBeNull();
    expect(opensPhrase('next week')).toBeNull();
  });
});

describe('availablePhrase', () => {
  // 20261031000100. The film row's date format: 2031-05-16 is a Friday.
  it('says the day it became available, in the film row’s format', () => {
    expect(availablePhrase('2031-05-16', new Date(2031, 4, 16))).toBe('Available in the US from May 16');
    expect(availablePhrase('2031-05-16', new Date(2031, 5, 1))).toBe('Available in the US from May 16');
    // A reader whose own calendar is still the day before gets the weekday.
    expect(availablePhrase('2031-05-16', new Date(2031, 4, 15))).toBe(
      'Available in the US from Fri, May 16',
    );
  });

  it('refuses anything that is not a calendar date', () => {
    expect(availablePhrase(null)).toBeNull();
    expect(availablePhrase('soon')).toBeNull();
  });
});

describe('premiereName', () => {
  const season = (seasonNumber: number | null, mediaTitle: string | null, seriesTitle: string | null) => ({
    seasonNumber,
    mediaTitle,
    seriesTitle,
  });

  it('names the show and the season, spelled out', () => {
    expect(premiereName(season(3, 'Season 3', 'Severance'))).toBe('Severance, Season 3');
    // The payload's number, even where the season has a name of its own.
    expect(premiereName(season(2, 'The Final Chapter', 'Severance'))).toBe('Severance, Season 2');
  });

  it('falls back to the season’s own title without a number', () => {
    expect(premiereName(season(null, 'The Final Chapter', 'Severance'))).toBe(
      'Severance, The Final Chapter',
    );
    expect(premiereName(season(null, 'Chernobyl: The Miniseries', 'Chernobyl'))).toBe(
      'Chernobyl: The Miniseries',
    );
    expect(premiereName(season(null, 'Season 3', null))).toBe('Season 3');
    expect(premiereName(season(3, null, null))).toBe('Season 3');
    expect(premiereName(season(null, null, 'Severance'))).toBeNull();
  });
});
