/**
 * The decompressor, plugged in behind `ArchiveSource` — and nothing else.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE EXISTS SEPARATELY FROM `archive.ts`
 *
 * `archive.ts` decides *what may be read* and is a pure function over a listing, so it can
 * be reviewed and tested without a ZIP library anywhere near it. This file is the other
 * half: the one dependency decision, isolated, so that swapping `fflate` for something else
 * later touches one module and no policy.
 *
 * ---------------------------------------------------------------------------
 * THE PRIVACY GUARANTEE IS MECHANICAL, NOT A PROMISE
 *
 * `archive.ts` says the excluded files are *never extracted*, which is stronger than *not
 * imported* and is the claim worth making — a decompressor that inflates everything and
 * then discards most of it has still put somebody's reviews, their comments and their
 * deliberately **deleted** diary entries into this process's memory.
 *
 * `fflate`'s `unzipSync` is what makes the stronger claim keepable. It walks the archive's
 * central directory and calls the filter with each member's name and declared sizes
 * *before* it inflates anything; a filter that returns `false` costs that entry nothing but
 * a few bytes of header parsing. So:
 *
 *   pass 1  filter returns false for everything  -> a listing, with nothing decompressed
 *   `inspect()`                                  -> the bounds, then the four wanted paths
 *   pass 2  filter returns true for one path     -> exactly that member inflated
 *
 * The bomb guard therefore runs *between* the passes, on sizes the central directory
 * declares, which is what `archive.ts`'s header means by "the bounds come before the
 * bytes". An archive that declares 900 MB is refused having inflated nothing at all.
 *
 * ---------------------------------------------------------------------------
 * `size` IS THE COMPRESSED ONE. IT IS NOT THE ONE WE WANT.
 *
 * `fflate` names the compressed length `size` and the uncompressed length `originalSize`,
 * which is the opposite of how both words read. `ArchiveEntry.bytes` is the *uncompressed*
 * size — the number a decompression bomb inflates to and the only one a bomb guard can be
 * written against — so it comes from `originalSize`. Reading `size` here would leave the
 * guard measuring the very number an attacker makes small on purpose, and every test would
 * still pass, because a legitimate archive's two numbers are within a few times each other.
 * `zip.test.ts` pins this with a member whose ratio is large enough that the two cannot be
 * confused.
 *
 * ---------------------------------------------------------------------------
 * SYNCHRONOUS, ON PURPOSE
 *
 * `fflate` also offers an async `unzip` that moves work to a worker thread. React Native
 * has no Web Workers, so that path degrades to something we would be relying on without
 * being able to describe. `unzipSync` is honest about where the work happens, and the work
 * is small: pass 1 is a header walk, and pass 2 inflates at most four CSVs that have each
 * already been bounded. The caller yields to the UI before invoking it — see
 * `use-import.ts`, which is where a decision about frame budget belongs.
 */

import { strFromU8, unzipSync } from 'fflate';

import type { ArchiveEntry, ArchiveSource } from './archive';

/** The smallest legal ZIP is an empty one: a 22-byte end-of-central-directory record. */
const MIN_ZIP_BYTES = 22;

/** `PK\x03\x04`, the local file header every non-empty ZIP opens with. */
const SIGNATURE = [0x50, 0x4b, 0x03, 0x04] as const;

/**
 * Whether the bytes even claim to be a ZIP.
 *
 * Checked before `unzipSync`, which finds its way around by scanning backwards for the
 * end-of-central-directory signature and, on something that is not an archive at all, spends
 * that scan over the whole buffer before failing. More to the point, "this is not a ZIP" and
 * "this ZIP is damaged" are different things to tell somebody, and only one of them is worth
 * saying "you may have picked the wrong file" about.
 */
export function looksLikeZip(bytes: Uint8Array): boolean {
  if (bytes.length < MIN_ZIP_BYTES) return false;
  return SIGNATURE.every((byte, i) => bytes[i] === byte);
}

export class NotAZipError extends Error {
  constructor() {
    super('not a zip archive');
    this.name = 'NotAZipError';
  }
}

export class DamagedZipError extends Error {
  constructor(cause?: unknown) {
    super('this archive could not be read');
    this.name = 'DamagedZipError';
    this.cause = cause;
  }
}

/**
 * Wraps ZIP bytes as the source `inspect()` and `readWanted()` already know how to drive.
 *
 * The listing is walked once and memoised, because `inspect` asks for it once and a caller
 * that asks again should not pay for it twice. Entries are inflated lazily, one call to
 * `readEntry` at a time, so the four wanted files are never all resident at once.
 *
 * @throws NotAZipError if the bytes are not an archive.
 * @throws DamagedZipError if they are one and it cannot be walked.
 */
export function zipSource(bytes: Uint8Array): ArchiveSource {
  if (!looksLikeZip(bytes)) throw new NotAZipError();

  let listing: ArchiveEntry[] | null = null;

  const list = (): readonly ArchiveEntry[] => {
    if (listing !== null) return listing;

    const entries: ArchiveEntry[] = [];
    try {
      unzipSync(bytes, {
        filter: (file) => {
          // `originalSize`, not `size`. See the header: `size` is the compressed length,
          // and a bomb guard written against that measures the wrong number.
          entries.push({ path: file.name, bytes: file.originalSize });
          // Nothing is inflated by the listing pass. This `false` is the privacy guarantee.
          return false;
        },
      });
    } catch (error) {
      throw new DamagedZipError(error);
    }

    listing = entries;
    return listing;
  };

  const readEntry = (path: string): string => {
    // **First match only**, because `inspect` chose this path with `find` and a malformed
    // archive may carry the same name twice. Without the latch the filter would accept both
    // and `unzipSync` would hand back the last, so the file checked against the bounds and
    // the file actually read would be different members — which is the whole guarantee,
    // inverted, in an archive somebody could write on purpose.
    let taken = false;

    let files: Record<string, Uint8Array>;
    try {
      files = unzipSync(bytes, {
        filter: (file) => {
          if (taken || file.name !== path) return false;
          taken = true;
          return true;
        },
      });
    } catch (error) {
      throw new DamagedZipError(error);
    }

    const found = files[path];
    if (found === undefined) throw new DamagedZipError(`entry vanished between passes: ${path}`);

    // UTF-8. A byte-order mark is left on the front for `parseCsv` to strip, which already
    // does and has the test for it; stripping it twice is how one of them stops being true.
    return strFromU8(found);
  };

  return { list, readEntry };
}
