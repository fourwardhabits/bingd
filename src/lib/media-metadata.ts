/**
 * What a title's genres and original language *are*, once a season is allowed to be
 * part of its show.
 *
 * THE PROBLEM THIS EXISTS FOR
 *
 * A season row carries almost nothing descriptive. The seeded catalogue gives seasons a
 * title, a number and a date and nothing else, and `tmdb_upsert_seasons`
 * (`20260815000000`) writes neither `genres` nor `original_language` — not as an
 * oversight but because TMDB publishes them on the *series*. So every rule in the app
 * that asked a media item for its genre or its language was, in practice, a rule about
 * films: `The Last of Us, S1` is not a drama, is not Japanese, is not anything.
 *
 * That was visible as three separate bugs — genre awards that television could never
 * contribute to, a collection genre filter that emptied the TV tab, and a For You wall
 * whose TV anchors vanished the moment a genre was picked — and it is one defect.
 *
 * THE RULE
 *
 * A season inherits stable descriptive metadata from its parent series when it does not
 * carry that metadata itself.
 *
 *   effectiveGenres(movie)   = the movie's own
 *   effectiveGenres(season)  = the season's own if it has any, else the series'
 *   effectiveGenres(series)  = the series' own
 *
 * and the same shape for the original language. Own-first rather than parent-first, so
 * a season that ever *does* carry its own genres — a TMDB change, an anthology series
 * enriched per season — wins over the show's, which is the more specific truth.
 *
 * **Resolved at read time, never copied.** Writing the series' genres onto every season
 * row would be a migration, would need a backfill, and would need re-running every time
 * a series was re-enriched — three ways for a season to end up describing a show it no
 * longer matches. The parent relationship already exists (`media_items.parent_id`) and
 * every query that wants this metadata is already embedding the parent for its title,
 * so inheritance costs two more columns on an embed that was being fetched anyway.
 *
 * **Absent stays absent.** A season with no parent, or a parent that carries nothing
 * either, resolves to no genres and a null language — and every caller already treats
 * those as unknown rather than as false. Nothing here guesses from a title, and nothing
 * here fetches: a client-side provider call to fill one field is how a list view turns
 * into fifty requests.
 */

/** The shape any row must present to be resolved. Deliberately structural. */
export type MetadataSubject = {
  kind: 'movie' | 'season' | 'series';
  /** `media_items.genres`, in whichever vocabulary that row carries. */
  genres?: readonly string[] | null;
  /** `media_items.original_language`, ISO 639-1. */
  language?: string | null;
  /**
   * The parent series, where one was read.
   *
   * Absent and null are the same thing here: a movie has no parent, and a season whose
   * parent could not be resolved is in the same position as one that has none.
   */
  parent?: { genres?: readonly string[] | null; language?: string | null } | null;
};

/** Whether a row's own genres are worth using rather than falling through. */
const hasOwnGenres = (genres: readonly string[] | null | undefined): boolean =>
  Array.isArray(genres) && genres.some((genre) => typeof genre === 'string' && genre.trim() !== '');

/** Whether a row's own language is worth using rather than falling through. */
const hasOwnLanguage = (language: string | null | undefined): boolean =>
  typeof language === 'string' && language.trim() !== '';

/**
 * The genres to reason about this title with.
 *
 * Always an array, never null: "no genres" and "genres we could not read" are the same
 * thing to every caller, and an empty array is the shape they all already handle.
 */
export function effectiveGenres(subject: MetadataSubject): string[] {
  if (hasOwnGenres(subject.genres)) return [...(subject.genres as readonly string[])];
  // Only a season falls through. A movie with no genres has no genres, and a series is
  // the thing being inherited *from* — giving either one a parent's metadata would be
  // inventing a relationship the catalogue does not have.
  if (subject.kind === 'season' && hasOwnGenres(subject.parent?.genres)) {
    return [...(subject.parent!.genres as readonly string[])];
  }
  return [];
}

/** The original language to reason about this title with, or null when unknown. */
export function effectiveLanguage(subject: MetadataSubject): string | null {
  if (hasOwnLanguage(subject.language)) return subject.language!.trim();
  if (subject.kind === 'season' && hasOwnLanguage(subject.parent?.language)) {
    return subject.parent!.language!.trim();
  }
  return null;
}

/**
 * The PostgREST column list for a media row that will be resolved.
 *
 * Kept here rather than written out at each call site so that adding an inherited field
 * later is one edit rather than a search. The parent embed asks for the *same* two
 * descriptive columns it inherits, plus the title every one of these queries was
 * already fetching for `compactName`.
 *
 * `parent:parent_id(...)` is the foreign-key form PostgREST resolves to `media_items`
 * itself — the self-join a season needs — and it is a left join, so a movie simply
 * comes back with `parent: null`.
 */
export const MEDIA_METADATA_COLUMNS =
  'genres, original_language, parent:parent_id(title, genres, original_language)';

/** The embedded parent as PostgREST types it: an object, declared as an array. */
export type EmbeddedParent =
  | { title?: string | null; genres?: string[] | null; original_language?: string | null }
  | { title?: string | null; genres?: string[] | null; original_language?: string | null }[]
  | null;

/** The one place that unwraps it, so no caller has to remember the array case. */
export const parentOf = (parent: EmbeddedParent) =>
  (Array.isArray(parent) ? parent[0] : parent) ?? null;

/**
 * A row straight out of PostgREST, resolved.
 *
 * The adapter between the wire shape and {@link MetadataSubject}, so a query result can
 * be handed over without every caller rebuilding the same object literal.
 */
export function resolveMetadata(row: {
  kind: 'movie' | 'season' | 'series';
  genres?: string[] | null;
  original_language?: string | null;
  parent?: EmbeddedParent;
}): { genres: string[]; language: string | null; seriesTitle: string | null } {
  const parent = parentOf(row.parent ?? null);
  const subject: MetadataSubject = {
    kind: row.kind,
    genres: row.genres,
    language: row.original_language,
    parent: parent ? { genres: parent.genres, language: parent.original_language } : null,
  };
  return {
    genres: effectiveGenres(subject),
    language: effectiveLanguage(subject),
    seriesTitle: parent?.title ?? null,
  };
}
