/**
 * From bytes somebody picked to the numbers they are shown before anything is sent.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A PURE FUNCTION OVER BYTES
 *
 * Everything between "a file exists" and "here is what we found in it" happens here, with
 * no picker, no network and no React. That is what lets the whole reading path — the bomb
 * guard, the four-file rule, the CSV parser, the correlation keys, the pagination — be
 * tested against the founder's real export and against archives nobody would want to build
 * by hand, on a machine with no phone attached.
 *
 * The hook above it (`use-import.ts`) owns the two things that genuinely need a device: the
 * system picker, and yielding the frame before this runs.
 *
 * ---------------------------------------------------------------------------
 * NOTHING LEAVES UNTIL SOMEBODY HAS SEEN THE COUNTS
 *
 * `readArchive` never talks to the server. It returns a preview, and the preview is what
 * the screen renders: films, ratings, watchlist, viewing dates, and anything the archive
 * was confused about. The import begins on a separate, deliberate tap.
 *
 * That ordering is the product decision from Contract V3 §8 — an import is somebody's
 * history and the last honest moment to say "not this one" is before it is uploaded, not
 * after it has been applied.
 */

import { DEFAULT_LIMITS, inspect, readWanted, type ArchiveLimits, type RefusalReason } from './archive';
import { normalise, type Normalised } from './letterboxd';
import { paginate, stagingRows, type StagingRow } from './payload';
import { DamagedZipError, NotAZipError, zipSource } from './zip';

/**
 * Why an archive could not be read, in the terms the screen apologises in.
 *
 * `not_a_zip` and `not_letterboxd` are the two a person can actually act on — they picked
 * the wrong file, or unzipped it first — and they are deliberately distinct, because
 * "that's not a zip" and "that's a zip of something else" call for different advice.
 */
export type ReadFailure =
  | { readonly reason: 'not_a_zip' }
  | { readonly reason: 'damaged' }
  | { readonly reason: RefusalReason }
  | { readonly reason: 'empty' };

export type ArchivePreview = {
  readonly normalised: Normalised;
  /** The rows as they would cross the wire, so the preview counts what will be sent. */
  readonly rows: readonly StagingRow[];
  /** Pre-split, so the screen can say "1 of 9" without re-deriving the split. */
  readonly pages: readonly (readonly StagingRow[])[];
};

export type ReadResult = { readonly ok: true; readonly preview: ArchivePreview } | ({ readonly ok: false } & ReadFailure);

/**
 * Reads a picked archive as far as the preview, and no further.
 *
 * @param now Injected so the year bound is testable and does not drift with the clock.
 */
export function readArchive(
  bytes: Uint8Array,
  { now, limits = DEFAULT_LIMITS }: { now?: Date; limits?: ArchiveLimits } = {},
): ReadResult {
  let source;
  try {
    source = zipSource(bytes);
  } catch (error) {
    if (error instanceof NotAZipError) return { ok: false, reason: 'not_a_zip' };
    return { ok: false, reason: 'damaged' };
  }

  let found;
  try {
    // The bounds run here, on sizes the archive declares, before a byte is inflated.
    const inspection = inspect(source, limits);
    if (!inspection.ok) return { ok: false, reason: inspection.reason };
    found = inspection.found;
  } catch (error) {
    if (error instanceof DamagedZipError) return { ok: false, reason: 'damaged' };
    throw error;
  }

  let normalised: Normalised;
  try {
    normalised = normalise(readWanted(source, found), now ? { now } : {});
  } catch (error) {
    if (error instanceof DamagedZipError) return { ok: false, reason: 'damaged' };
    throw error;
  }

  const rows = stagingRows(normalised);

  // **An archive that is a valid Letterboxd export and holds nothing.** A brand-new account
  // exports a `watched.csv` with a header and no rows. There is nothing wrong with it and
  // nothing to import, and saying "0 films — Import" would be a button that does nothing.
  if (rows.length === 0) return { ok: false, reason: 'empty' };

  return { ok: true, preview: { normalised, rows, pages: paginate(rows) } };
}
