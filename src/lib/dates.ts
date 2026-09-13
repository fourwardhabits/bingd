/**
 * Bare calendar dates, formatted the one way this app formats them.
 *
 * TMDB publishes a bare `YYYY-MM-DD` with no time and no zone, and so does the watch
 * date a reader picks: `user_media.watched_on` is a `date` (20260813000500), not a
 * timestamp. `new Date('2013-06-02')` is parsed as **midnight UTC**, so west of
 * Greenwich it renders as the day before — an episode that aired on the 2nd shown as the
 * 1st, on every device in the Americas. The fix is to pin both ends: construct at
 * `T00:00:00Z` and render with `timeZone: 'UTC'`, so the date that comes out is the date
 * that went in wherever the reader is.
 *
 * It lives here rather than beside one of its callers because it has three: an episode's
 * air date on the season page's Episodes tab, the same row inside the comparison's recall
 * sheet, and the watch date on the title page's identity line. Two of those were
 * byte-identical local copies of each other in one file. A second copy is how the two
 * drift, and the drift would be invisible — a date wrong by one day, in one hemisphere,
 * on one of the screens.
 */

/**
 * A short UTC-pinned date: `2 Jun 2013`.
 *
 * Short rather than long because every caller sets it on a metadata line — beside a
 * runtime, beside an ordinal — rather than under a heading with room for `February`.
 *
 * Null passes straight through, and the caller drops the half of the line it would have
 * filled. An unaired episode with no announced date is the ordinary case, not an error.
 */
export function formatShortDate(date: string | null | undefined) {
  if (!date) return null;
  return new Date(`${date}T00:00:00Z`).toLocaleDateString(undefined, {
    timeZone: 'UTC',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}
