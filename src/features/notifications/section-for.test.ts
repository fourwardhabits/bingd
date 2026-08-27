import { relativeTime } from '@/features/recommendations/use-sent-to-you';

import { sectionFor } from './use-notifications';

/**
 * The shelf boundaries, and the one contract that matters about them: a row can never
 * sit under a heading its own timestamp contradicts. `sectionFor` uses the same
 * rounding `relativeTime` uses, so the pair is asserted together — if either changes
 * its arithmetic alone, the mismatch fails here rather than on somebody's phone.
 */
describe('sectionFor', () => {
  const now = Date.UTC(2026, 7, 27, 12, 0, 0);
  const ago = (ms: number) => new Date(now - ms).toISOString();
  const HOUR = 60 * 60 * 1000;
  const DAY = 24 * HOUR;

  it('shelves the recent hours as today', () => {
    expect(sectionFor(ago(0), now)).toBe('today');
    expect(sectionFor(ago(2 * HOUR), now)).toBe('today');
    expect(sectionFor(ago(23 * HOUR), now)).toBe('today');
  });

  it('moves to this week exactly where the label starts saying days', () => {
    // 23.5 hours rounds to 24, which relativeTime already reads as "1d ago" — so the
    // shelf moves with the label, not at a private midnight of its own.
    const edge = ago(23.5 * HOUR);
    expect(relativeTime(edge, now)).toBe('1d ago');
    expect(sectionFor(edge, now)).toBe('week');

    expect(sectionFor(ago(2 * DAY), now)).toBe('week');
    expect(sectionFor(ago(6.4 * DAY), now)).toBe('week');
  });

  it('moves to earlier exactly where the label says a full week', () => {
    const edge = ago(6.6 * DAY);
    expect(relativeTime(edge, now)).toBe('7d ago');
    expect(sectionFor(edge, now)).toBe('earlier');

    expect(sectionFor(ago(30 * DAY), now)).toBe('earlier');
  });

  it('shelves an unparseable date as earlier rather than throwing', () => {
    expect(sectionFor('not a date', now)).toBe('earlier');
  });
});
