import { addDays, addMonths, formatWatchDate, monthGrid, toIso } from './dates';

/**
 * Watch dates are local calendar dates, and every bug in this file is the same bug:
 * something reached for UTC or for a raw `Date` and moved the day.
 */

describe('toIso', () => {
  it('uses local parts rather than the UTC instant', () => {
    // 1 Jan at 00:30 local is still 31 Dec in UTC anywhere east of it. `toISOString()`
    // would report the wrong day, and the user would log a watch against yesterday.
    expect(toIso(new Date(2026, 0, 1, 0, 30))).toBe('2026-01-01');
  });

  it('pads single digits', () => {
    expect(toIso(new Date(2026, 2, 4, 12))).toBe('2026-03-04');
  });
});

describe('addDays', () => {
  it('steps back over a month boundary', () => {
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
  });

  it('steps back over a year boundary', () => {
    expect(addDays('2026-01-01', -1)).toBe('2025-12-31');
  });

  it('handles a leap day', () => {
    expect(addDays('2024-03-01', -1)).toBe('2024-02-29');
  });
});

describe('addMonths', () => {
  it('does not skip February when the day of month does not exist there', () => {
    // The classic: Date rolls 31 February forward into March, so stepping back one
    // month from 31 March lands in March again and the calendar refuses to move.
    expect(addMonths('2026-03-31', -1)).toBe('2026-02-01');
  });

  it('crosses a year boundary', () => {
    expect(addMonths('2026-01-15', -1)).toBe('2025-12-01');
  });
});

describe('formatWatchDate', () => {
  const now = '2026-08-15';

  it('names today and yesterday rather than dating them', () => {
    expect(formatWatchDate('2026-08-15', now)).toBe('Today');
    expect(formatWatchDate('2026-08-14', now)).toBe('Yesterday');
  });

  it('dates anything older', () => {
    expect(formatWatchDate('2026-08-13', now)).not.toBe('Yesterday');
    expect(formatWatchDate('2026-08-13', now)).toMatch(/13/);
  });

  it('includes the year only when it differs', () => {
    expect(formatWatchDate('2026-01-04', now)).not.toMatch(/2026/);
    expect(formatWatchDate('2020-01-04', now)).toMatch(/2020/);
  });
});

describe('monthGrid', () => {
  it('pads the leading blanks so the first day lands on its weekday', () => {
    // 1 August 2026 is a Saturday, so six blanks precede it in a Sunday-first grid.
    const cells = monthGrid('2026-08-10');
    expect(cells.slice(0, 6).every((cell) => cell === null)).toBe(true);
    expect(cells[6]).toBe('2026-08-01');
  });

  it('covers the whole month and stops', () => {
    const cells = monthGrid('2026-02-10');
    const days = cells.filter((cell): cell is string => cell !== null);

    expect(days).toHaveLength(28);
    expect(days.at(-1)).toBe('2026-02-28');
  });

  it('includes 29 February in a leap year', () => {
    const days = monthGrid('2024-02-10').filter(Boolean);
    expect(days.at(-1)).toBe('2024-02-29');
  });

  it('emits no trailing blanks', () => {
    expect(monthGrid('2026-08-10').at(-1)).not.toBeNull();
  });
});
