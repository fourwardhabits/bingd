import type { PersonCredit } from './use-person';

/** The last tie-break: the catalogue id, so equal credits still order one way. */
const byId = (a: PersonCredit, b: PersonCredit) =>
  a.mediaItemId < b.mediaItemId ? -1 : a.mediaItemId > b.mediaItemId ? 1 : 0;

/**
 * How many of a person's most popular eligible acting credits compete on rating.
 *
 * `order` is the cache's popularity order — the provider's ranking of this person's work —
 * so the first ten are the titles people know them for. Rating alone would hand the hero
 * to a two-minute cameo in a revered classic; inside this window, the best-rated wins
 * among work that is genuinely theirs (founder spec §6: "meaningful relevance").
 */
export const HERO_RELEVANCE_WINDOW = 10;

/**
 * **Which of a person's credits lends the person page its hero** (founder QA P1-9; rating
 * first since founder spec §6, 2026-11-13).
 *
 * Nothing new is fetched for it. The adapter already writes every credited title into
 * `media_items` with its `backdrop_path`, and every credit already carries `score` —
 * TMDB's audience rating, confidence-weighted by vote count and **null below the vote
 * floor** (`tmdbScore`, `supabase/functions/tmdb-adapter/normalize.ts`). That null is the
 * reliability guard: a nearly unreviewed title has no score here, so it cannot win on one.
 * bingd's own sparse user scores are never consulted.
 *
 * THE ORDER, AND WHY
 *
 *   0. **Eligible** means: an acting credit (cast), not a self-appearance — a talk show,
 *      the news, a reality programme, an awards ceremony (the adapter's `self` flag) —
 *      with a backdrop, released on or before `today` (an announced project, or an
 *      undated one, has nothing anybody has seen).
 *   1. **The highest-rated of their best-known work.** Among the first
 *      {@link HERO_RELEVANCE_WINDOW} eligible credits in popularity order, the highest
 *      `score`; only credits with a score compete. Ties go to the more popular credit
 *      (`order`), then the catalogue id.
 *   2. **Else the most recently released**, when none of that work has a reliable rating:
 *      newest `releaseDate` first, ties by `order`, then id. This was the whole rule
 *      before §6, and it is the fallback the spec asks for.
 *   3. **Then their work behind the camera that has a backdrop**, for a director, writer
 *      or producer with no on-screen work: the most recently released first, and only
 *      then an undated or upcoming one, most popular first. A self-appearance is still
 *      excluded. Unchanged from before.
 *   4. **Else null**, and the page draws the branded band it always drew.
 *
 * Pure and deterministic — `today` is a parameter (`YYYY-MM-DD`) and every comparison
 * ends on the catalogue id — so the same filmography always picks the same picture, and
 * the hero cannot change between renders.
 */
export function pickPersonBackdrop(
  credits: readonly PersonCredit[],
  today: string,
): PersonCredit | null {
  const released = (credit: PersonCredit) =>
    Boolean(credit.backdropPath) &&
    !credit.self &&
    credit.releaseDate !== null &&
    credit.releaseDate <= today;

  const byPopularity = (a: PersonCredit, b: PersonCredit) => a.order - b.order || byId(a, b);

  const newest = (pool: PersonCredit[]) =>
    [...pool].sort(
      (a, b) =>
        // Newest first; both are `YYYY-MM-DD`, so the comparison is a string one.
        (b.releaseDate! < a.releaseDate! ? -1 : b.releaseDate! > a.releaseDate! ? 1 : 0) ||
        byPopularity(a, b),
    )[0] ?? null;

  const acting = credits.filter((credit) => credit.as === 'cast' && released(credit));
  if (acting.length) {
    const rated = [...acting]
      .sort(byPopularity)
      .slice(0, HERO_RELEVANCE_WINDOW)
      .filter((credit) => credit.score !== null && Number.isFinite(credit.score));
    if (rated.length) {
      return [...rated].sort((a, b) => b.score! - a.score! || byPopularity(a, b))[0]!;
    }
    return newest(acting);
  }

  const crew = credits.filter(
    (credit) => credit.crewRole !== null && Boolean(credit.backdropPath) && !credit.self,
  );
  const releasedCrew = crew.filter(released);
  if (releasedCrew.length) return newest(releasedCrew);
  // Undated or upcoming: the cache's popularity order, which `order` already is.
  if (crew.length) return [...crew].sort(byPopularity)[0]!;

  return null;
}
