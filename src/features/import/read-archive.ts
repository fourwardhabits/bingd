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
  | { readonly reason: 'empty' }
  /**
   * Something threw that none of the above describes.
   *
   * Exists so that this function is **total**. An earlier version rethrew anything that was
   * not a `DamagedZipError`, and the caller's `try` did not cover the call — so an
   * unexpected throw anywhere in the parse became an unhandled rejection, the phase stayed
   * `reading` for ever, and the screen it left behind is a spinner with no buttons on it.
   * A reader that cannot fail to return is worth more here than a precise taxonomy of
   * failures nobody can act on anyway.
   */
  | { readonly reason: 'unexpected' };

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
  try {
    const source = zipSource(bytes);

    // The bounds run here, on sizes the archive declares, before a byte is inflated.
    const inspection = inspect(source, limits);
    if (!inspection.ok) return { ok: false, reason: inspection.reason };

    const normalised: Normalised = normalise(
      readWanted(source, inspection.found),
      now ? { now } : {},
    );
    const rows = stagingRows(normalised);

    // **An archive that is a valid Letterboxd export and holds nothing.** A brand-new
    // account exports a `watched.csv` with a header and no rows. There is nothing wrong
    // with it and nothing to import, and saying "0 films — Import" would be a button that
    // does nothing.
    if (rows.length === 0) return { ok: false, reason: 'empty' };

    return { ok: true, preview: { normalised, rows, pages: paginate(rows) } };
  } catch (error) {
    // One catch for the whole read, so that adding a step above cannot reintroduce a path
    // that escapes. The two shapes worth naming are named; everything else is `unexpected`
    // rather than rethrown, because the caller has nowhere to put a throw.
    if (error instanceof NotAZipError) return { ok: false, reason: 'not_a_zip' };
    if (error instanceof DamagedZipError) return { ok: false, reason: 'damaged' };
    return { ok: false, reason: 'unexpected' };
  }
}
