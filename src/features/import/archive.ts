/**
 * What may be taken out of a Letterboxd archive, and what may never be opened.
 *
 * ---------------------------------------------------------------------------
 * THIS IS A PRIVACY BOUNDARY, NOT A CONVENIENCE
 *
 * A real export contains `reviews.csv`, `comments.csv`, `profile.csv`, three `likes/`
 * files, every custom list, and `deleted/` — which holds diary entries, reviews and
 * comments the person **deliberately deleted**. The import contract excludes all of it.
 *
 * "Excluded" is implemented here as *never extracted*, which is a stronger claim than
 * *not imported* and is the one worth making. A decompressor that reads every entry and
 * then discards most of them has still put somebody's review text and deleted activity
 * into the process's memory; the only way to promise that it did not is to never ask for
 * those entries at all. `select()` names four paths, `readEntry` is called for those four,
 * and `archive.test.ts` asserts the reader was never asked for anything else.
 *
 * ---------------------------------------------------------------------------
 * AND THE BOUNDS COME BEFORE THE BYTES
 *
 * `inspect()` takes a listing — path and *declared* uncompressed size, both of which a
 * ZIP central directory carries without decompressing anything — and refuses an archive
 * that is too large or has too many members before a single entry is expanded. That is
 * what makes a decompression bomb a refusal rather than an out-of-memory crash on
 * somebody's phone.
 *
 * ---------------------------------------------------------------------------
 * NO ZIP LIBRARY IS IMPORTED HERE, ON PURPOSE
 *
 * This module is a pure function over a listing. Whatever eventually produces that
 * listing — a pure-JS inflater, a native picker handing over an already-unzipped folder,
 * or a test fixture — plugs in behind `ArchiveSource`. The decision about which
 * decompressor to ship is a dependency decision and is not made here, so this file can be
 * tested, reviewed and relied upon before that decision exists.
 */

/** The four files the contract permits, as path suffixes. Nothing else may be read. */
export const WANTED = ['watched.csv', 'ratings.csv', 'diary.csv', 'watchlist.csv'] as const;

export type WantedFile = (typeof WANTED)[number];

/**
 * Everything a real export contains that must never be opened, listed so the exclusion is
 * a statement somebody can read rather than an absence they have to infer.
 *
 * Not used as a denylist, and `isWanted` does not consult it. Matching is a positive rule
 * — the file at the archive root, or one wrapper folder and then the file — so a folder
 * Letterboxd adds next year is excluded by default rather than by having been anticipated.
 * This list is documentation with a test attached.
 */
export const NEVER_READ = [
  'profile.csv',
  'reviews.csv',
  'comments.csv',
  'likes/films.csv',
  'likes/reviews.csv',
  'likes/lists.csv',
  'deleted/diary.csv',
  'deleted/reviews.csv',
  'deleted/comments.csv',
  'orphaned/diary.csv',
  'orphaned/reviews.csv',
  'orphaned/comments.csv',
] as const;

/** One member of an archive, as a listing reports it before anything is decompressed. */
export type ArchiveEntry = {
  readonly path: string;
  /** Declared uncompressed size in bytes, from the archive's own directory. */
  readonly bytes: number;
};

export type ArchiveSource = {
  list(): readonly ArchiveEntry[];
  /** Called only for paths `select()` returned. Decodes as UTF-8. */
  readEntry(path: string): string;
};

export type ArchiveLimits = {
  readonly maxEntries: number;
  readonly maxTotalBytes: number;
  readonly maxEntryBytes: number;
};

/**
 * Deliberately generous, because the real numbers are tiny and the limits exist to stop an
 * attack rather than to ration a library.
 *
 * The founder's 22-film export is a few kilobytes. A 10,000-film export — the
 * architectural ceiling the Collection reader imposes — is on the order of 1.5 MB of CSV
 * across the four files we read, and perhaps three times that including the ones we do
 * not. 50 MB and 50 entries are therefore several orders of magnitude above anything
 * legitimate, which is where a bomb guard belongs: high enough that no real user meets it,
 * low enough that nothing can exhaust a phone.
 */
export const DEFAULT_LIMITS: ArchiveLimits = {
  maxEntries: 50,
  maxTotalBytes: 50 * 1024 * 1024,
  maxEntryBytes: 25 * 1024 * 1024,
};

export type RefusalReason = 'too_many_entries' | 'too_large' | 'entry_too_large' | 'not_letterboxd';

/**
 * Where each wanted file was found.
 *
 * Only `watched.csv` is guaranteed. The other three are legitimately absent from real
 * exports, and typing them as required would push a lie through every consumer — the
 * reason `readWanted` returns `string | null` per file rather than assuming four strings.
 */
export type FoundPaths = Readonly<Partial<Record<WantedFile, string>>> & {
  readonly 'watched.csv': string;
};

export type Inspection =
  | { readonly ok: true; readonly found: FoundPaths }
  | { readonly ok: false; readonly reason: RefusalReason };

/**
 * Whether one listed path is the wanted file, allowing for a wrapping folder.
 *
 * Letterboxd's archive may or may not nest its contents under a dated folder, and both
 * shapes have been reported in the wild. Matching on a `/`-delimited suffix accepts
 * `watched.csv` and `letterboxd-saisurajkan-2026-09-10/watched.csv` alike.
 *
 * The `/`-boundary is what stops `deleted/diary.csv` from satisfying `diary.csv`: the
 * suffix test requires the character before the match to be a separator, and
 * `deleted/diary.csv` would match `diary.csv` on a naive `endsWith`. That is not a
 * hypothetical — `deleted/` and `orphaned/` both contain a file named `diary.csv`, and
 * importing the deleted one would resurrect entries somebody removed on purpose.
 */
function normalisePath(path: string): string | null {
  // Backslashes are a legal ZIP entry separator on archives written by some Windows tools.
  const segments = path.replace(/\\/g, '/').toLowerCase().split('/');
  const out: string[] = [];

  for (const segment of segments) {
    // `//` and `/./` are both spellings of "nothing", and every ZIP reader resolves them —
    // so a matcher that did not would accept `deleted/./diary.csv` as `diary.csv` while
    // the decompressor happily handed back the deleted diary.
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      // An entry that climbs out of the archive is malformed by any reading. Refusing it
      // outright is safer than resolving it, because a resolved `deleted/x/../diary.csv`
      // is still the deleted diary.
      if (out.length === 0) return null;
      out.pop();
      continue;
    }
    out.push(segment);
  }

  return out.length === 0 ? null : out.join('/');
}

/**
 * Whether one listed path is the wanted file.
 *
 * **Positive rule, not a denylist.** An earlier version allowed any path ending in the
 * wanted name unless its parent folder was one of three known-bad names, and that was
 * wrong twice over: it accepted `deleted/./diary.csv`, `deleted//diary.csv` and
 * `deleted/x/../diary.csv`, all of which a ZIP reader resolves straight back to the
 * deleted diary; and it would have accepted an `archived/` or `hidden/` folder Letterboxd
 * adds next year — which is precisely the failure this module's own docblock says a
 * denylist has.
 *
 * The rule now is the shape a real archive actually has: the file at the root, or one
 * wrapper folder and then the file. `deleted/diary.csv` fails it because `deleted` is not
 * the wrapper — and when there *is* a wrapper, `inspect` requires all four files to share
 * it, so a `deleted` folder cannot become one by being the only thing present.
 */
function isWanted(path: string, wanted: WantedFile): boolean {
  const normalised = normalisePath(path);
  if (normalised === null) return false;

  const segments = normalised.split('/');
  if (segments[segments.length - 1] !== wanted) return false;
  return segments.length <= 2;
}

/** The wrapper folder a normalised path sits in, or '' for an entry at the root. */
function wrapperOf(path: string): string | null {
  const normalised = normalisePath(path);
  if (normalised === null) return null;
  const segments = normalised.split('/');
  return segments.length === 1 ? '' : segments.slice(0, -1).join('/');
}

/**
 * Applies the bounds, then resolves the four wanted paths.
 *
 * `watched.csv` is the only file whose absence means "this is not a Letterboxd export".
 * The other three are legitimately missing from a real account: somebody who has never
 * rated anything has no `ratings.csv` worth reading, and the founder's own export ships
 * `reviews.csv` as a bare header. Treating any of those as fatal would refuse valid
 * exports.
 */
export function inspect(
  source: ArchiveSource,
  limits: ArchiveLimits = DEFAULT_LIMITS,
): Inspection {
  const entries = source.list();

  if (entries.length > limits.maxEntries) return { ok: false, reason: 'too_many_entries' };

  let total = 0;
  for (const entry of entries) {
    // **A directory that does not declare a size has not been checked, and an unchecked
    // entry must be refused rather than counted as free.** An earlier version read this
    // same intent and then wrote `: 0`, which meant an archive declaring `0` for every
    // member — one field edit in an attacker-controlled central directory — sailed past
    // the total and got inflated anyway. Clamping *up* turns a lie into a refusal.
    const declared =
      Number.isFinite(entry.bytes) && entry.bytes >= 0 ? entry.bytes : limits.maxEntryBytes + 1;
    if (declared > limits.maxEntryBytes) return { ok: false, reason: 'entry_too_large' };
    total += declared;
  }
  if (total > limits.maxTotalBytes) return { ok: false, reason: 'too_large' };

  // `watched.csv` decides the wrapper, and the other three must share it. Resolving each
  // file independently would let a wanted name be picked up from a different folder than
  // the rest of the export came from.
  const watchedEntry = entries.find((e) => isWanted(e.path, 'watched.csv'));
  if (watchedEntry === undefined) return { ok: false, reason: 'not_letterboxd' };

  const wrapper = wrapperOf(watchedEntry.path);
  if (wrapper === null) return { ok: false, reason: 'not_letterboxd' };

  const found: Partial<Record<WantedFile, string>> = { 'watched.csv': watchedEntry.path };
  for (const wanted of WANTED) {
    if (wanted === 'watched.csv') continue;
    const hit = entries.find((e) => isWanted(e.path, wanted) && wrapperOf(e.path) === wrapper);
    if (hit) found[wanted] = hit.path;
  }

  return { ok: true, found: { ...found, 'watched.csv': watchedEntry.path } };
}

/** The four files' text, read through `inspect` and nothing else. Absent files are null. */
export type ArchiveText = Readonly<Record<WantedFile, string | null>>;

export function readWanted(source: ArchiveSource, found: FoundPaths): ArchiveText {
  const out: Partial<Record<WantedFile, string | null>> = {};
  for (const wanted of WANTED) {
    const path = found[wanted];
    out[wanted] = path === undefined ? null : source.readEntry(path);
  }
  return out as ArchiveText;
}
