import {
  groupByYear,
  hasHistory,
  inWatchOrder,
  labelFor,
  movementDirection,
  movementSentence,
  placementsByWatch,
  watchCountLabel,
  type WatchEvent,
} from './watch-history';

/**
 * What a watch history means, asserted where it has no network and no React around it.
 *
 * These rules are written down here because the entry line and the screen both read
 * them, and the first time they disagreed would be a screen saying *Watched 6 times*
 * over five rows.
 */

const event = (
  id: string,
  watchedOn: string | null,
  recordedAt: string,
  basis: WatchEvent['basis'] = watchedOn ? 'reader' : 'none',
  importRef: string | null = null,
): WatchEvent => ({ id, watchedOn, basis, importRef, recordedAt });

describe('inWatchOrder', () => {
  it('puts the undated viewing first, because it is the one nobody can place', () => {
    // "Watched at some point" is the oldest thing anybody can say about a title. Putting
    // it after this year's rewatch would read as the reader having forgotten last Tuesday.
    const rows = inWatchOrder([
      event('b', '2026-09-01', '2026-09-01T10:00:00Z'),
      event('a', null, '2026-01-01T10:00:00Z'),
      event('c', '2019-03-03', '2026-02-02T10:00:00Z'),
    ]);
    expect(rows.map((r) => r.id)).toEqual(['a', 'c', 'b']);
  });

  it('breaks a same-day tie by recording time, which is its only job here', () => {
    const rows = inWatchOrder([
      event('late', '2026-09-01', '2026-09-01T22:00:00Z'),
      event('early', '2026-09-01', '2026-09-01T09:00:00Z'),
    ]);
    expect(rows.map((r) => r.id)).toEqual(['early', 'late']);
  });

  it('does not mutate what it is given', () => {
    const input = [event('b', '2026-09-01', '2026-09-01T10:00:00Z'), event('a', null, 'x')];
    const copy = [...input];
    inWatchOrder(input);
    expect(input).toEqual(copy);
  });
});

describe('labelFor', () => {
  const dated = [
    event('first', '2019-01-12', '2026-01-01T10:00:00Z'),
    event('second', '2026-02-02', '2026-02-02T10:00:00Z'),
  ];

  it('names the earliest dated viewing the first watch', () => {
    expect(labelFor(dated, 0)).toBe('first');
    expect(labelFor(dated, 1)).toBe('rewatch');
  });

  it('never calls an UNDATED viewing the first watch, even though it sorts first', () => {
    // §D.2. The reader has not told us it was first — it is the viewing they cannot
    // place, and it might have been the tenth.
    const withUndated = [event('unknown', null, '2026-01-01T10:00:00Z'), ...dated];
    expect(labelFor(withUndated, 0)).toBe('earlier');
    expect(labelFor(withUndated, 1)).toBe('first');
    expect(labelFor(withUndated, 2)).toBe('rewatch');
  });
});

describe('watchCountLabel', () => {
  it('never says "Watched 1 time"', () => {
    // Founder-locked (§J.2). One viewing keeps the sentence the page already had: the
    // date, or nothing where there is no date.
    expect(watchCountLabel(0)).toBeNull();
    expect(watchCountLabel(1)).toBeNull();
  });

  it('appears from the second watch, which is the first moment it says anything', () => {
    expect(watchCountLabel(2)).toBe('Watched 2 times');
    expect(watchCountLabel(11)).toBe('Watched 11 times');
  });
});

describe('hasHistory', () => {
  it('is true for any seen title, because one dated watch still has a date to edit', () => {
    expect(hasHistory(1)).toBe(true);
    expect(hasHistory(6)).toBe(true);
  });

  it('is false for a title nobody has watched', () => {
    expect(hasHistory(0)).toBe(false);
  });
});

describe('groupByYear', () => {
  it('reads newest first and puts the undated viewing last, under no year', () => {
    // The opposite end from `inWatchOrder`, deliberately: the screen reads newest-first,
    // so the viewing nobody can place is the furthest thing from "what happened
    // recently" — and §J.2's wireframe puts *Earlier* at the bottom.
    const groups = groupByYear([
      event('u', null, '2026-01-01T10:00:00Z'),
      event('a', '2019-01-12', '2026-01-01T10:00:00Z'),
      event('b', '2019-03-03', '2026-01-02T10:00:00Z'),
      event('c', '2026-02-02', '2026-02-02T10:00:00Z'),
    ]);

    expect(groups.map((g) => g.year)).toEqual([2026, 2019, null]);
    expect(groups[1]?.events.map((e) => e.id)).toEqual(['b', 'a']);
    expect(groups[2]?.events.map((e) => e.id)).toEqual(['u']);
  });

  it('returns nothing for a title with no viewings rather than an empty year', () => {
    expect(groupByYear([])).toEqual([]);
  });
});

describe('movementSentence — private, and exact at any depth (§E.2)', () => {
  it('prints the movement with both ordinals, however deep', () => {
    expect(movementSentence({ outcome: 'moved', fromPosition: 118 }, 72)).toBe(
      'Moved from #118 → #72',
    );
  });

  it('says Still #N only when both neighbours were confirmed', () => {
    expect(movementSentence({ outcome: 'unchanged', fromPosition: 312 }, 312)).toBe('Still #312');
  });

  it('says Still #N when the reader skipped out, and when a band change keeps the ordinal', () => {
    expect(movementSentence({ outcome: 'kept', fromPosition: 57 }, 57)).toBe('Still #57');
    expect(movementSentence({ outcome: 'moved', fromPosition: 4 }, 4)).toBe('Still #4');
  });

  it('says nothing about a first placement, which moved from nowhere', () => {
    expect(movementSentence({ outcome: 'placed', fromPosition: null }, 4)).toBeNull();
    expect(movementSentence({ outcome: 'moved', fromPosition: null }, 4)).toBeNull();
  });
});

describe('movementDirection', () => {
  it('points up when the ordinal got smaller, which is higher in the list', () => {
    expect(movementDirection({ outcome: 'moved', fromPosition: 118 }, 72)).toBe('up');
    expect(movementDirection({ outcome: 'moved', fromPosition: 4 }, 6)).toBe('down');
  });

  it('has no arrow for anything that did not move', () => {
    expect(movementDirection({ outcome: 'unchanged', fromPosition: 33 }, 33)).toBeNull();
    expect(movementDirection({ outcome: 'kept', fromPosition: 57 }, 57)).toBeNull();
    expect(movementDirection({ outcome: 'placed', fromPosition: null }, 1)).toBeNull();
  });
});

describe('placementsByWatch — one displayed placement per viewing (founder QA, 2026-09-21)', () => {
  const watch = (id: string, recordedAt: string, watchedOn: string | null = null): WatchEvent => ({
    id,
    watchedOn,
    basis: 'reader',
    importRef: null,
    recordedAt,
  });
  const placed = (
    id: string,
    createdAt: string,
    position: number,
    watchEventId: string | null = null,
  ) => ({ id, createdAt, position, categorySize: 11, score: 8, watchEventId });

  it('collapses a single viewing with three ledger rows to the newest one', () => {
    const shown = placementsByWatch(
      [watch('w1', '2026-09-01T10:00:00Z')],
      [
        placed('p1', '2026-09-01T10:01:00Z', 8),
        placed('p2', '2026-09-05T10:00:00Z', 5),
        placed('p3', '2026-09-10T10:00:00Z', 4),
      ],
    );
    expect(shown.size).toBe(1);
    expect(shown.get('w1')?.id).toBe('p3');
  });

  it('gives each viewing its own span, and a correction after the rewatch updates only the rewatch', () => {
    const shown = placementsByWatch(
      [watch('w1', '2026-09-01T10:00:00Z'), watch('w2', '2026-09-20T10:00:00Z')],
      [
        placed('first', '2026-09-01T10:01:00Z', 8),
        placed('fix-1', '2026-09-02T10:00:00Z', 7),
        placed('again', '2026-09-20T10:02:00Z', 2, 'w2'),
        placed('fix-2', '2026-09-21T10:00:00Z', 3),
      ],
    );
    expect(shown.get('w1')?.id).toBe('fix-1');
    expect(shown.get('w2')?.id).toBe('fix-2');
  });

  it('shows the inherited placement on a viewing that was never ranked', () => {
    const shown = placementsByWatch(
      [watch('w1', '2026-09-01T10:00:00Z'), watch('w2', '2026-09-20T10:00:00Z')],
      [placed('first', '2026-09-01T10:01:00Z', 8)],
    );
    expect(shown.get('w2')?.id).toBe('first');
  });

  it('leaves a viewing with no placement at all unmapped', () => {
    expect(placementsByWatch([watch('w1', '2026-09-01T10:00:00Z')], []).size).toBe(0);
  });
});
