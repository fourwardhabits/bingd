import type { BreakdownRow, WatchedTitle } from './tracks';

/** One cell of the background. Nothing but the artwork and a key React can use. */
export type CelebrationPoster = {
  key: string;
  posterPath: string;
};

export type CelebrationGrid = {
  columns: number;
  rows: number;
  posters: CelebrationPoster[];
};

/**
 * The two densities, and why there are exactly two.
 *
 * A phone is about 390pt wide. Three columns puts a poster at ~130pt, which is an image
 * somebody can recognise; four puts it at ~97pt, which is still a film you can name. Five
 * columns and ten rows — fifty posters — is what a wall of thumbnails looks like when
 * nobody decided how big a poster should be: at 78pt each, over a card, it is texture
 * rather than a collection, and the reader cannot pick out a single thing they watched.
 *
 * So: **3 × 3 when there are fewer than 25 posters to draw from, 4 × 5 at 25 and above.**
 * The switch is at the point where a 3 × 3 would be showing a third of a large
 * collection, which is where the denser grid starts to say something the sparse one
 * cannot.
 */
export const SMALL_GRID = { columns: 3, rows: 3 } as const;
export const LARGE_GRID = { columns: 4, rows: 5 } as const;
export const DENSITY_THRESHOLD = 25;

/**
 * A stable 32-bit hash of a string. FNV-1a, which is four lines and has no dependency.
 *
 * Used for ordering and for nothing else — there is no security property being claimed
 * here. What is being claimed is *determinism*: the same award, the same tier and the
 * same title always produce the same number, on every device and on every render,
 * without anything being written down.
 */
export function stableHash(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    // The FNV prime, by shifts, so this stays inside 32 bits in JavaScript.
    hash =
      (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
  }
  return hash >>> 0;
}

/**
 * Was this title already in the collection when the award was earned?
 *
 * `watchedOn` is a **date**, not a timestamp, and the unlock is an instant — so the
 * comparison is on the date part, and a title watched on the same day as the unlock
 * counts. That is the right way round: the alternative drops the very title that
 * probably crossed the threshold.
 *
 * **A title with no watch date is kept.** Most rows have none — `watched_on` is
 * optional and always has been — and excluding them would empty the background for
 * exactly the readers who log without dating. The cost is stated in `celebrationGrid`.
 */
function withinAsOf(watchedOn: string | null | undefined, asOf: string | null): boolean {
  if (!watchedOn || !asOf) return true;
  return watchedOn <= asOf.slice(0, 10);
}

/**
 * The posters behind an award celebration: which ones, how many, and in what order.
 *
 * ---------------------------------------------------------------------------
 * DETERMINISTIC, AND NOTHING IS STORED
 *
 * The founder's requirement is that the background does not change after the award is
 * earned — reopening it from a notification a week later shows the same wall. The
 * obvious way to get that is to write the chosen poster list down at unlock time, and
 * that is a migration, a new column and a new thing that can disagree with the
 * collection it describes.
 *
 * Instead the order is a pure function of facts that never change: the award key, the
 * tier key, and the media id. `stableHash` turns that tuple into a number and the list
 * is sorted by it. Same award, same wall, for ever, on any device, with nothing
 * persisted — and identical whether the reader arrived from the ranking that earned it
 * or from a notification a week later.
 *
 * **The honest limitation, stated rather than papered over.** The *candidate set* is
 * still read live, so it can move: a comedy logged next month is a new candidate for LOL
 * Mode and can hash into the top nine, and a title deleted from the collection leaves.
 * `withinAsOf` narrows this to titles whose watch date is not after the unlock, which
 * covers the ordinary case — somebody logging what they watch as they watch it — and
 * does nothing for the rows that carry no date. Freezing it completely means storing the
 * list, and the founder ruled that out for a visual background. So: the wall is stable
 * for a collection that only grows forward in time, and may shift for one that is
 * backfilled with old watch dates.
 * ---------------------------------------------------------------------------
 *
 * **Contributing titles first.** "Watch 25 comedies" should be a wall of comedies, not a
 * wall of whatever is in the collection — the background is an argument that the award
 * was earned. `contributing` is the award's own breakdown, which is the same call the
 * metric is measured from, so a poster here is a title that genuinely counted.
 *
 * **Then the collection, to fill.** An award about invites or comments has no titles of
 * its own, and a title award at its first tier may have fewer than the grid holds. Both
 * fall through to the reader's collection as of the unlock — which is still *their*
 * wall, just not the award's.
 *
 * **No fake posters, and no empty cells** (reversed 2026-09-21, founder QA). This used to
 * say "never a duplicate: nine cells showing the same three posters three times is worse
 * than six cells", and to leave a small collection a smaller wall. The wall was never
 * smaller: `CelebrationBackdrop` sizes it to whole rows so it covers the screen, and the
 * missing cells were a gray block behind the card — at five ranked titles, the smallest
 * collection that can earn anything, the screen looked unfinished. So the reader's own
 * posters are **tiled to fill every cell** (`tileWall`): repeats, but never the same poster
 * beside itself where the count allows it, and never artwork they do not own.
 */
export function celebrationGrid({
  contributing,
  collection,
  awardKey,
  tierKey,
  asOf = null,
}: {
  /** The award's own breakdown rows. Empty for a track that is not about titles. */
  contributing: readonly BreakdownRow[];
  /** Everything the reader has logged, for the fill. */
  collection: readonly WatchedTitle[];
  awardKey: string;
  tierKey: string;
  /**
   * `award_unlocks.earned_at`, for the eligibility freeze. Null means "do not narrow" —
   * which is what a client that could not read the ledger has, and a wall built from the
   * whole collection is a better answer there than an empty one.
   *
   * **Deliberately not part of the seed.** The seed has to be identical on both routes
   * into the celebration — a ranking that just detected the unlock, and a notification
   * opened a week later — and a timestamp is the one field those two could disagree on
   * by a millisecond, which would produce two different walls for one award. `(award,
   * tier)` is already unique per account by the ledger's own primary key, so it is
   * enough on its own.
   */
  asOf?: string | null;
}): CelebrationGrid {
  const seed = `${awardKey}:${tierKey}`;
  const order = (poster: CelebrationPoster) => stableHash(`${seed}:${poster.key}`);

  const dedupe = (posters: CelebrationPoster[], seen: Set<string>) => {
    const out: CelebrationPoster[] = [];
    for (const poster of posters) {
      if (seen.has(poster.key)) continue;
      seen.add(poster.key);
      out.push(poster);
    }
    return out;
  };

  /**
   * When each title was watched, by media id.
   *
   * **A breakdown row does not carry a watch date** — it carries a rendered `detail`
   * string like "Watched 12 Aug 2026", which is copy rather than data and is absent
   * on most tracks. The collection does carry it, structured, and `titleRow` keys a
   * breakdown row by `mediaItemId`, so the collection is where the date for a
   * contributing row comes from. Parsing the sentence would be reading the interface.
   */
  const watchedOnById = new Map(
    collection.map((title) => [title.mediaItemId, title.watchedOn ?? null]),
  );

  const seen = new Set<string>();
  const primary = dedupe(
    contributing
      .filter((row) => row.posterPath && withinAsOf(watchedOnById.get(row.key), asOf))
      .map((row) => ({ key: row.key, posterPath: row.posterPath as string })),
    seen,
  ).sort((a, b) => order(a) - order(b));

  const fill = dedupe(
    collection
      .filter((title) => title.posterPath && withinAsOf(title.watchedOn, asOf))
      .map((title) => ({ key: title.mediaItemId, posterPath: title.posterPath as string })),
    seen,
  ).sort((a, b) => order(a) - order(b));

  /**
   * **Density is decided by everything usable, not by the primary set alone.**
   *
   * One rule rather than two. An award about comments has no contributing posters at
   * all, and a rule that read only the primary set would put every non-title award on
   * the sparse grid however large the reader's collection is — which is the case where
   * the dense one looks best.
   */
  const usable = primary.length + fill.length;
  const { columns, rows } = usable >= DENSITY_THRESHOLD ? LARGE_GRID : SMALL_GRID;

  return {
    columns,
    rows,
    posters: tileWall([...primary, ...fill], columns, rows),
  };
}

/**
 * Every cell of a `columns × rows` wall, from however many distinct posters there are.
 *
 * - **Enough posters:** the first `columns × rows`, in the order given, with no repeats —
 *   unchanged from before, which is why a collection of ten or more looks exactly as it did.
 * - **Too few:** the posters are walked cyclically in their given (stable, per-award) order,
 *   and each cell takes the next one that is not the same as the cell to its **left** or the
 *   cell **above** it. With two or more posters that is always possible, so no poster ever
 *   sits directly beside or beneath itself; with one, the only honest wall is that poster.
 *   The first `n` cells are the `n` distinct posters in order, so the award's own titles
 *   still lead.
 * - **None at all:** nothing, and the screen draws no wall (`celebrate.tsx`).
 *
 * Deterministic: the same posters in the same order give the same wall, which keeps the
 * "same wall every time" rule the order above is built for. A repeated cell's `key` carries
 * a `~n` suffix, so every cell has a unique key while the first occurrence keeps the title id.
 */
export function tileWall(
  unique: readonly CelebrationPoster[],
  columns: number,
  rows: number,
): CelebrationPoster[] {
  const cells = columns * rows;
  if (unique.length === 0) return [];
  if (unique.length >= cells) return unique.slice(0, cells);

  const source: number[] = []; // index into `unique` for each cell
  const out: CelebrationPoster[] = [];
  const uses = new Map<string, number>();
  let next = 0;

  for (let cell = 0; cell < cells; cell += 1) {
    const left = cell % columns === 0 ? -1 : (source[cell - 1] ?? -1);
    const above = cell < columns ? -1 : (source[cell - columns] ?? -1);

    let pick = next % unique.length;
    for (let step = 0; step < unique.length; step += 1) {
      const candidate = (next + step) % unique.length;
      if (candidate !== left && candidate !== above) {
        pick = candidate;
        break;
      }
    }

    const poster = unique[pick] as CelebrationPoster;
    const count = uses.get(poster.key) ?? 0;
    uses.set(poster.key, count + 1);
    source.push(pick);
    out.push(count === 0 ? poster : { ...poster, key: `${poster.key}~${count}` });
    next = pick + 1;
  }
  return out;
}
