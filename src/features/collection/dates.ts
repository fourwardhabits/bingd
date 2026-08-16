/**
 * Watch dates, as local calendar dates rather than instants.
 *
 * `log_watched` takes `YYYY-MM-DD` because what a user means by "last night" is a
 * date in their own timezone, and sending a timestamp lets the server's UTC day
 * disagree with the one they were looking at (writes.ts). Everything here therefore
 * works on the string form and on local-time `Date` parts, never on `toISOString()`,
 * which would silently shift the date for anyone west of UTC.
 */

/** The local calendar date, formatted the way the database wants it. */
export const today = () => toIso(new Date());

export const toIso = (date: Date) => {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
};

/** Midday, so a day's arithmetic cannot be undone by a daylight-saving shift. */
export const fromIso = (iso: string) => {
  const [year, month, day] = iso.split('-').map(Number);
  return new Date(year ?? 1970, (month ?? 1) - 1, day ?? 1, 12);
};

export const addDays = (iso: string, days: number) => {
  const date = fromIso(iso);
  date.setDate(date.getDate() + days);
  return toIso(date);
};

/**
 * How a watch date reads in a row.
 *
 * Today and yesterday are named rather than dated, because that is how someone
 * describes a watch they have just logged, and it is the overwhelmingly common case.
 */
export const formatWatchDate = (iso: string, now = today()) => {
  if (iso === now) return 'Today';
  if (iso === addDays(now, -1)) return 'Yesterday';

  const date = fromIso(iso);
  const sameYear = date.getFullYear() === fromIso(now).getFullYear();
  return date.toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    ...(sameYear ? {} : { year: 'numeric' }),
  });
};

export const monthLabel = (iso: string) =>
  fromIso(iso).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });

export const addMonths = (iso: string, months: number) => {
  const date = fromIso(iso);
  const target = date.getMonth() + months;
  // Clamp the day before shifting the month, or 31 March minus one month lands in
  // March again — Date rolls 31 February forward rather than refusing it.
  date.setDate(1);
  date.setMonth(target);
  return toIso(date);
};

/**
 * The cells of a month grid, Sunday-first, with `null` for the leading blanks.
 *
 * Trailing blanks are not emitted: a partial final row is what a calendar looks
 * like, and padding it adds a row of empty tap targets a screen reader has to walk.
 */
export const monthGrid = (iso: string): (string | null)[] => {
  const date = fromIso(iso);
  const year = date.getFullYear();
  const month = date.getMonth();

  const firstWeekday = new Date(year, month, 1, 12).getDay();
  const daysInMonth = new Date(year, month + 1, 0, 12).getDate();

  return [
    ...Array.from({ length: firstWeekday }, () => null),
    ...Array.from({ length: daysInMonth }, (_, index) => toIso(new Date(year, month, index + 1, 12))),
  ];
};

/** Sunday-first initials for the grid header. */
export const WEEKDAY_INITIALS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'] as const;
