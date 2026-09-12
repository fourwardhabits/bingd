import type { ArchiveText } from './archive';
import { bucketFor, correlationKey, displayName, normalise } from './letterboxd';
import { REAL_EXPORT } from './__fixtures__/real-export';

/** The day after the real export was taken, so its one diary date is in range. */
const NOW = new Date(2026, 8, 11);

const text = (files: Partial<ArchiveText>): ArchiveText => ({
  'watched.csv': null,
  'ratings.csv': null,
  'diary.csv': null,
  'watchlist.csv': null,
  ...files,
});

const run = (files: Partial<ArchiveText>) => normalise(text(files), { now: NOW });
const find = (result: ReturnType<typeof run>, name: string) =>
  result.watched.find((t) => t.name === name);

// ---------------------------------------------------------------------------
// The locked star policy
// ---------------------------------------------------------------------------

describe('bucketFor', () => {
  it('puts 3.5 in "I liked it"', () => {
    // The founder's decision, and the boundary most likely to be revisited. bingd's top
    // bucket is labelled "I liked it", not "I loved it", and 3.5 of 5 is liking something.
    expect(bucketFor(3.5)).toBe('loved');
  });

  it.each([
    [5, 'loved'],
    [4.5, 'loved'],
    [4, 'loved'],
    [3.5, 'loved'],
    [3, 'fine'],
    [2.5, 'fine'],
    [2, 'not_for_me'],
    [1.5, 'not_for_me'],
    [1, 'not_for_me'],
    [0.5, 'not_for_me'],
  ])('maps %s stars to %s', (rating, bucket) => {
    expect(bucketFor(rating)).toBe(bucket);
  });

  it('has no bucket for an unrated film', () => {
    expect(bucketFor(null)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The real export
// ---------------------------------------------------------------------------

describe('the founder’s real export', () => {
  const result = normalise(REAL_EXPORT, { now: NOW });

  it('reads all twenty-two watched films and both watchlist items', () => {
    expect(result.counts).toMatchObject({
      watched: 22,
      watchlist: 2,
      rated: 22,
      watches: 1,
      malformed: 0,
      watchlistAlreadyWatched: 0,
    });
  });

  it('splits the ratings nine, eight and five', () => {
    const count = (bucket: string) => result.watched.filter((t) => t.bucket === bucket).length;
    expect([count('loved'), count('fine'), count('not_for_me')]).toEqual([9, 8, 5]);
  });

  it('gives exactly one film a watch date, and it is the diary’s', () => {
    // THE trap. Every row of watched.csv and ratings.csv carries `Date: 2026-09-11`, and
    // twenty-one of these films have no genuine viewing date anywhere in the export. If
    // `Date` ever leaks into `watched_on`, this expectation goes to 22 and the monthly
    // leaderboard, the yearly goal and the collection's own history all inherit a lie.
    const dated = result.watched.filter((t) => t.watchedOn !== null);
    expect(dated).toHaveLength(1);
    expect(dated[0]!.name).toBe('Free Solo');
    expect(dated[0]!.watchedOn).toBe('2026-09-10');
    expect(result.counts.dated).toBe(1);
  });

  it('never lets an export-activity date become a watch date', () => {
    for (const title of result.watched) {
      expect(title.watchedOn).not.toBe('2026-09-11');
    }
  });

  it('keeps the film URI and the diary URI apart', () => {
    // Free Solo is boxd.it/iEEq as a film and boxd.it/ggWgth as a diary entry. Joining on
    // "the URI" would produce a second, unmatched title and hang the date off nothing.
    expect(find(result, 'Free Solo')!.filmUri).toBe('https://boxd.it/iEEq');
    expect(result.watches[0]!.diaryUri).toBe('https://boxd.it/ggWgth');
    expect(result.watches[0]!.correlation).toBe(find(result, 'Free Solo')!.correlation);
  });

  it('records that the one diary entry was a rewatch', () => {
    // Which is why no watch count is displayed: one diary row marked Rewatch means at
    // least two viewings, and the first has no date anywhere.
    expect(result.watches[0]!.isRewatch).toBe(true);
  });

  it('reads whole stars written without a decimal', () => {
    expect(find(result, 'The Odyssey')!.rating).toBe(4);
    expect(find(result, 'Free Solo')!.rating).toBe(5);
    expect(find(result, 'Project Hail Mary')!.rating).toBe(3.5);
  });

  it('keeps a year that lives inside a title', () => {
    const film = find(result, 'Blade Runner 2049')!;
    expect(film.year).toBe(2017);
    expect(film.name).toBe('Blade Runner 2049');
  });

  it('keeps punctuation verbatim for the matcher', () => {
    expect(find(result, 'Sisi & I')).toBeDefined();
    expect(find(result, 'X-Men: The Last Stand')).toBeDefined();
    expect(find(result, 'Joker: Folie à Deux')).toBeDefined();
  });

  it('does not put a watchlist film in the collection', () => {
    expect(find(result, 'Obsession')).toBeUndefined();
    expect(result.watchlist.map((w) => w.name).sort()).toEqual(['Coyote vs. Acme', 'Obsession']);
  });

  it('never produces a ranking or a score — there is no field for one', () => {
    for (const title of result.watched) {
      expect(title).not.toHaveProperty('position');
      expect(title).not.toHaveProperty('score');
    }
  });
});

// ---------------------------------------------------------------------------
// What the real export cannot cover
// ---------------------------------------------------------------------------

describe('a watchlist film that has already been watched', () => {
  it('is dropped from the watchlist and counted', () => {
    // The highest-severity ordering rule in the design, and the real export cannot test it:
    // both its watchlist films are unreleased. Server-side the `_leave_watchlist` triggers
    // fire on any watch signal, so importing this row would insert a watchlist entry that
    // the database then deletes — or worse, in the other order, resurrect one.
    const result = run({
      'watched.csv': 'Date,Name,Year,Letterboxd URI\n2026-09-11,Shrek,2001,https://boxd.it/29zi\n',
      'watchlist.csv':
        'Date,Name,Year,Letterboxd URI\n' +
        '2026-09-11,Shrek,2001,https://boxd.it/29zi\n' +
        '2026-09-11,Obsession,2025,https://boxd.it/PNqo\n',
    });

    expect(result.watchlist.map((w) => w.name)).toEqual(['Obsession']);
    expect(result.counts.watchlistAlreadyWatched).toBe(1);
  });

  it('drops a duplicated watchlist row', () => {
    const result = run({
      'watched.csv': 'Date,Name,Year,Letterboxd URI\n',
      'watchlist.csv':
        'Date,Name,Year,Letterboxd URI\n' +
        '2026-09-11,Obsession,2025,https://boxd.it/PNqo\n' +
        '2026-09-11,Obsession,2025,https://boxd.it/PNqo\n',
    });
    expect(result.watchlist).toHaveLength(1);
  });
});

describe('a watched film with no rating', () => {
  it('is logged with no bucket, which is a state the model already has', () => {
    const result = run({
      'watched.csv': 'Date,Name,Year,Letterboxd URI\n2026-09-11,Shrek,2001,https://boxd.it/29zi\n',
      'ratings.csv': 'Date,Name,Year,Letterboxd URI,Rating\n',
    });

    expect(result.watched).toHaveLength(1);
    expect(result.watched[0]!.rating).toBeNull();
    expect(result.watched[0]!.bucket).toBeNull();
    expect(result.counts.rated).toBe(0);
  });
});

describe('a film rated but absent from watched.csv', () => {
  it('is still watched, because a rating implies a viewing', () => {
    const result = run({
      'watched.csv': 'Date,Name,Year,Letterboxd URI\n',
      'ratings.csv':
        'Date,Name,Year,Letterboxd URI,Rating\n2026-09-11,Shrek,2001,https://boxd.it/29zi,4\n',
    });
    expect(result.watched).toHaveLength(1);
    expect(result.watched[0]!.bucket).toBe('loved');
  });
});

describe('several diary entries for one film', () => {
  const result = run({
    'watched.csv': 'Date,Name,Year,Letterboxd URI\n2026-09-11,Shrek,2001,https://boxd.it/29zi\n',
    'diary.csv':
      'Date,Name,Year,Letterboxd URI,Rating,Rewatch,Tags,Watched Date\n' +
      '2026-09-11,Shrek,2001,https://boxd.it/aaa,4,,,2024-01-02\n' +
      '2026-09-11,Shrek,2001,https://boxd.it/bbb,4,Yes,,2026-03-04\n' +
      '2026-09-11,Shrek,2001,https://boxd.it/ccc,4,Yes,,2025-06-07\n',
  });

  it('collapses to one collection row carrying the most recent date', () => {
    expect(result.watched).toHaveLength(1);
    expect(result.watched[0]!.watchedOn).toBe('2026-03-04');
  });

  it('keeps every viewing separately, identified by its own diary URI', () => {
    expect(result.watches).toHaveLength(3);
    expect(result.watches.map((w) => w.diaryUri).sort()).toEqual([
      'https://boxd.it/aaa',
      'https://boxd.it/bbb',
      'https://boxd.it/ccc',
    ]);
    expect(result.watches.filter((w) => w.isRewatch)).toHaveLength(2);
  });

  it('drops a diary entry exported twice under the same URI', () => {
    const twice = run({
      'watched.csv': 'Date,Name,Year,Letterboxd URI\n',
      'diary.csv':
        'Date,Name,Year,Letterboxd URI,Rating,Rewatch,Tags,Watched Date\n' +
        '2026-09-11,Shrek,2001,https://boxd.it/aaa,4,,,2024-01-02\n' +
        '2026-09-11,Shrek,2001,https://boxd.it/aaa,4,,,2024-01-02\n',
    });
    expect(twice.watches).toHaveLength(1);
  });
});

describe('a diary URI never becomes a film URI', () => {
  // Independent review found both of these reachable and both silently wrong. `filmUri`
  // becomes the key of a GLOBAL, cross-account match cache, so one bad value there is
  // inherited by every later importer with no way to trace it.

  it('leaves filmUri null for a film only the diary mentions', () => {
    const result = run({
      'watched.csv': 'Date,Name,Year,Letterboxd URI\n',
      'diary.csv':
        'Date,Name,Year,Letterboxd URI,Rating,Rewatch,Tags,Watched Date\n' +
        '2026-09-11,Shrek,2001,https://boxd.it/DIARY,4,,,2024-01-02\n',
    });

    expect(result.watched).toHaveLength(1);
    expect(result.watched[0]!.filmUri).toBeNull();
    expect(result.watches[0]!.diaryUri).toBe('https://boxd.it/DIARY');
  });

  it('does not let the diary fill in a blank URI on a watched row', () => {
    const result = run({
      'watched.csv': 'Date,Name,Year,Letterboxd URI\n2026-09-11,Shrek,2001,\n',
      'diary.csv':
        'Date,Name,Year,Letterboxd URI,Rating,Rewatch,Tags,Watched Date\n' +
        '2026-09-11,Shrek,2001,https://boxd.it/DIARY,4,,,2024-01-02\n',
    });

    expect(result.watched[0]!.filmUri).toBeNull();
  });
});

describe('a damaged file is reported rather than silently truncated', () => {
  it('counts a file that ends inside an open quote', () => {
    // One stray quote on line 2 makes every later line part of one giant field. Without
    // the file-level flag this reports one film, zero malformed, and total success — for
    // an export that had four.
    const result = run({
      'watched.csv':
        'Date,Name,Year,Letterboxd URI\n' +
        '2026-09-11,"Shrek,2001,https://boxd.it/a\n' +
        '2026-09-11,Barbie,2023,https://boxd.it/b\n' +
        '2026-09-11,Odyssey,2026,https://boxd.it/c\n',
    });

    expect(result.counts.damagedFiles).toBe(1);
  });

  it('reports no damage for a well-formed archive', () => {
    expect(normalise(REAL_EXPORT, { now: NOW }).counts.damagedFiles).toBe(0);
  });

  it('counts a row whose field count does not match the header', () => {
    // A shifted row puts half a title in Year and a year in Rating. Dropping it and saying
    // so beats importing a wrong fact confidently.
    const result = run({
      'watched.csv':
        'Date,Name,Year,Letterboxd URI\n' +
        '2026-09-11,Shrek,2001\n' +
        '2026-09-11,Barbie,2023,https://boxd.it/b\n',
    });

    expect(result.counts.malformed).toBe(1);
    expect(result.watched.map((t) => t.name)).toEqual(['Barbie']);
  });
});

describe('when ratings.csv and a diary entry disagree', () => {
  it('takes ratings.csv, which the contract names as the authority', () => {
    // Letterboxd stores a film-page rating and a diary-entry rating separately, so this is
    // a real state rather than a corrupted file.
    const result = run({
      'watched.csv': 'Date,Name,Year,Letterboxd URI\n2026-09-11,Shrek,2001,https://boxd.it/29zi\n',
      'ratings.csv':
        'Date,Name,Year,Letterboxd URI,Rating\n2026-09-11,Shrek,2001,https://boxd.it/29zi,4.5\n',
      'diary.csv':
        'Date,Name,Year,Letterboxd URI,Rating,Rewatch,Tags,Watched Date\n' +
        '2026-09-11,Shrek,2001,https://boxd.it/aaa,1,,,2024-01-02\n',
    });

    expect(result.watched[0]!.rating).toBe(4.5);
    expect(result.watched[0]!.bucket).toBe('loved');
  });
});

describe('titles the export can contain and the fixture does not', () => {
  it('reads a title containing a comma', () => {
    const result = run({
      'watched.csv':
        'Date,Name,Year,Letterboxd URI\n' +
        '2026-09-11,"Crouching Tiger, Hidden Dragon",2000,https://boxd.it/zzz\n',
    });
    expect(result.watched[0]!.name).toBe('Crouching Tiger, Hidden Dragon');
    expect(result.watched[0]!.year).toBe(2000);
  });

  it('reads a non-Latin title without folding it', () => {
    const result = run({
      'watched.csv': 'Date,Name,Year,Letterboxd URI\n2026-09-11,万引き家族,2018,https://boxd.it/zzz\n',
    });
    expect(result.watched[0]!.name).toBe('万引き家族');
  });

  it('does not collide two films that differ only by an accent', () => {
    // The correlation key folds whitespace and case and nothing else, on purpose: this is
    // an intra-export join, not a catalogue probe, and a collision here would merge two
    // different films into one collection row.
    expect(correlationKey('Amélie', 2001)).not.toBe(correlationKey('Amelie', 2001));
  });

  it('correlates the same film written with different spacing and case', () => {
    expect(correlationKey('  The   Odyssey ', 2026)).toBe(correlationKey('the odyssey', 2026));
  });
});

describe('rows that cannot be read', () => {
  it('counts them and still imports everything else', () => {
    const result = run({
      'watched.csv':
        'Date,Name,Year,Letterboxd URI\n' +
        '2026-09-11,,2001,https://boxd.it/a\n' +
        `2026-09-11,${'x'.repeat(201)},2001,https://boxd.it/b\n` +
        '2026-09-11,Shrek,2001,https://boxd.it/29zi\n',
    });

    expect(result.counts.malformed).toBe(2);
    expect(result.watched).toHaveLength(1);
    expect(result.watched[0]!.name).toBe('Shrek');
  });

  it('keeps a film whose year is missing or nonsense, with a null year', () => {
    const result = run({
      'watched.csv':
        'Date,Name,Year,Letterboxd URI\n' +
        '2026-09-11,Shrek,,https://boxd.it/a\n' +
        '2026-09-11,Barbie,not-a-year,https://boxd.it/b\n',
    });
    expect(result.watched).toHaveLength(2);
    expect(result.watched.every((t) => t.year === null)).toBe(true);
  });

  it('discards a rating that is not on a half step rather than rounding it', () => {
    // Rounding 4.3 would put a film in a bucket the person never chose.
    const result = run({
      'watched.csv': 'Date,Name,Year,Letterboxd URI\n2026-09-11,Shrek,2001,https://boxd.it/a\n',
      'ratings.csv':
        'Date,Name,Year,Letterboxd URI,Rating\n2026-09-11,Shrek,2001,https://boxd.it/a,4.3\n',
    });
    expect(result.watched[0]!.rating).toBeNull();
    expect(result.watched[0]!.bucket).toBeNull();
  });

  it.each(['0', '5.5', '-2', '', 'four'])('discards the rating %p', (raw) => {
    const result = run({
      'watched.csv': 'Date,Name,Year,Letterboxd URI\n2026-09-11,Shrek,2001,https://boxd.it/a\n',
      'ratings.csv':
        `Date,Name,Year,Letterboxd URI,Rating\n2026-09-11,Shrek,2001,https://boxd.it/a,${raw}\n`,
    });
    expect(result.watched[0]!.rating).toBeNull();
  });
});

describe('watch dates that are not viewings', () => {
  it('discards a date past tomorrow, matching log_watched’s own bound', () => {
    const result = run({
      'watched.csv': 'Date,Name,Year,Letterboxd URI\n2026-09-11,Shrek,2001,https://boxd.it/a\n',
      'diary.csv':
        'Date,Name,Year,Letterboxd URI,Rating,Rewatch,Tags,Watched Date\n' +
        '2026-09-11,Shrek,2001,https://boxd.it/aaa,4,,,2027-01-01\n',
    });
    expect(result.watched[0]!.watchedOn).toBeNull();
    expect(result.watches).toHaveLength(0);
  });

  it('accepts tomorrow, because a client east of UTC reports one', () => {
    const result = run({
      'watched.csv': 'Date,Name,Year,Letterboxd URI\n2026-09-11,Shrek,2001,https://boxd.it/a\n',
      'diary.csv':
        'Date,Name,Year,Letterboxd URI,Rating,Rewatch,Tags,Watched Date\n' +
        '2026-09-11,Shrek,2001,https://boxd.it/aaa,4,,,2026-09-12\n',
    });
    expect(result.watched[0]!.watchedOn).toBe('2026-09-12');
  });

  it('discards a date that does not exist', () => {
    const result = run({
      'watched.csv': 'Date,Name,Year,Letterboxd URI\n2026-09-11,Shrek,2001,https://boxd.it/a\n',
      'diary.csv':
        'Date,Name,Year,Letterboxd URI,Rating,Rewatch,Tags,Watched Date\n' +
        '2026-09-11,Shrek,2001,https://boxd.it/aaa,4,,,2026-02-31\n',
    });
    expect(result.watched[0]!.watchedOn).toBeNull();
  });
});

describe('displayName', () => {
  it('strips a spreadsheet formula prefix', () => {
    expect(displayName('=cmd|/c calc')).toBe('cmd|/c calc');
    expect(displayName('@SUM(A1)')).toBe('SUM(A1)');
  });

  it('leaves the stored name verbatim, because it is matcher input', () => {
    // A film legitimately titled `-30-` must still match the catalogue. Sanitising happens
    // where the value is rendered, not where it is stored.
    const result = run({
      'watched.csv': 'Date,Name,Year,Letterboxd URI\n2026-09-11,-30-,1959,https://boxd.it/a\n',
    });
    expect(result.watched[0]!.name).toBe('-30-');
    expect(displayName(result.watched[0]!.name)).toBe('30-');
  });
});

describe('an empty account', () => {
  it('normalises to nothing at all, without failing', () => {
    const result = run({ 'watched.csv': 'Date,Name,Year,Letterboxd URI\n' });
    expect(result.watched).toEqual([]);
    expect(result.watchlist).toEqual([]);
    expect(result.watches).toEqual([]);
    expect(result.counts.malformed).toBe(0);
  });
});
