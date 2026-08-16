/**
 * How an exact media entity is named on screen.
 *
 * Founder amendment, 2026-08-16, after a device test showed the feed reading
 * "Suraj Kandukuri ranked Season 2". A season's own `title` is "Season 2" — that is
 * what TMDB stores and what the seed catalogue falls back to — which is a complete
 * name only where the series is already on screen. Everywhere else it names nothing.
 *
 * The rankable unit in this product is the season, never the series (PRD §10), so
 * the situation is not an edge case: half the things anybody ranks are called
 * "Season 2". This is the one place that decides what to call them.
 */

export type MediaKind = 'movie' | 'series' | 'season';

export type NameableTitle = {
  kind: MediaKind | null | undefined;
  title: string | null | undefined;
  /** The parent series' title, for a season. Null for anything else. */
  seriesTitle?: string | null;
};

/** An em dash with spaces, which is how the log sheet already joins the two. */
const JOIN = ' — ';

/**
 * The full name of an entity, including its series when it has one.
 *
 * `parentIsVisible` is the exception the founder allowed: on a series' own page,
 * inside its season list, "Season 2" is unambiguous and repeating the show's name
 * down the column is noise. Everywhere the parent is *not* already on screen — the
 * feed, a profile, search, a collection row, a share card — the long form is the
 * only one that identifies the thing.
 *
 * Defaulting `parentIsVisible` to false is deliberate: the failure mode of the long
 * form is a little repetition, and the failure mode of the short form is an activity
 * item about nothing. A caller has to ask for the short one.
 */
export function fullTitle(
  media: NameableTitle,
  { parentIsVisible = false }: { parentIsVisible?: boolean } = {},
): string | null {
  const own = media.title?.trim() || null;
  if (!own) return null;
  if (media.kind !== 'season' || parentIsVisible) return own;

  const series = media.seriesTitle?.trim() || null;
  if (!series) return own;

  // A season whose own title is the show's name plus something — TMDB does this for
  // limited series, where the single season is named after the show — would read as
  // "Chernobyl — Chernobyl". One name is enough when it already contains the other.
  if (own.toLowerCase().includes(series.toLowerCase())) return own;

  return `${series}${JOIN}${own}`;
}

/**
 * Whether two entities are the same exact thing.
 *
 * Used by the spoiler rules, where "has this viewer watched it" has to mean the
 * exact movie or the exact season and nothing broader: watching Season 1 must not
 * unmask Season 2, and having the series in a collection must not unmask any season
 * of it. Comparing ids is what makes that true by construction, so this exists to
 * name the rule rather than to add logic to it.
 */
export const isSameEntity = (a: string | null | undefined, b: string | null | undefined) =>
  Boolean(a) && a === b;
