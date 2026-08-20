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
 *
 * Founder amendment, 2026-08-18, the compact form. The join was ` — ` and the season
 * was spelled out, giving `Parks and Recreation — Season 2`. Two problems with that in
 * a row: an em dash is the widest glyph in the font and it was buying nothing a comma
 * does not, and "Season 2" is three times the width of "S2" in a column that is
 * already truncating. The standard is now:
 *
 *     The Last of Us, S1 (2023)
 *
 * The year is the row's own, not part of the name — `TitleRow` and `ActivityRow` both
 * print it themselves so it can be muted — which is why `compactName` stops before it
 * and `compactTitle` is the one-string form for the surfaces with nowhere to put it.
 *
 * A season *page* is not a compact context and keeps its hierarchy: the show on one
 * line, `Season 1, 2023` under it. That lives in the title screen, not here.
 */

export type MediaKind = 'movie' | 'series' | 'season';

export type NameableTitle = {
  kind: MediaKind | null | undefined;
  title: string | null | undefined;
  /** The parent series' title, for a season. Null for anything else. */
  seriesTitle?: string | null;
  /**
   * `media_items.season_number`, for a season.
   *
   * Optional because not every read selects it. When it is absent the number is
   * recovered from the season's own title, which TMDB writes as "Season 2" for all
   * but the limited series that name their one season after the show — and those are
   * the case that returns the season's own name anyway.
   */
  seasonNumber?: number | null;
};

/** `1` from `Season 1`, and nothing from a season named after its show. */
function seasonOrdinal(media: NameableTitle): number | null {
  if (typeof media.seasonNumber === 'number' && Number.isFinite(media.seasonNumber)) {
    return media.seasonNumber;
  }
  const match = media.title?.trim().match(/^season\s+(\d+)$/i);
  return match ? Number(match[1]) : null;
}

/**
 * The compact name of an entity, including its series when it has one.
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
export function compactName(
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
  // "Chernobyl, Chernobyl". One name is enough when it already contains the other.
  if (own.toLowerCase().includes(series.toLowerCase())) return own;

  const ordinal = seasonOrdinal(media);
  // No recoverable number means the season's own words are all there is to join with.
  // Rare, and better than inventing an S-number that is not in the data.
  return ordinal == null ? `${series}, ${own}` : `${series}, S${ordinal}`;
}

/**
 * The same name with the year attached — `The Last of Us, S1 (2023)`.
 *
 * For the surfaces that print one string and have no second slot to mute a year in:
 * a notification line, a sheet heading, a share body, an accessibility label. A row
 * with its own year column wants {@link compactName} and its own year instead, so the
 * year can be the quieter of the two.
 */
export function compactTitle(
  media: NameableTitle & { year?: number | string | null },
  options?: { parentIsVisible?: boolean },
): string | null {
  const name = compactName(media, options);
  if (!name) return null;
  const year = typeof media.year === 'string' ? media.year.slice(0, 4) : media.year;
  return year ? `${name} (${year})` : name;
}

/**
 * The previous name of {@link compactName}.
 *
 * Kept as an alias for one reason: it is called from fourteen modules and renaming it
 * in the same commit that changes what it returns would make a mechanical rename and a
 * behaviour change indistinguishable in the diff.
 *
 * @deprecated Prefer {@link compactName}, or {@link compactTitle} where the year has
 * nowhere else to go.
 */
export const fullTitle = compactName;

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
