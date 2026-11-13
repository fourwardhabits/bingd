import type { PersonCredit } from './use-person';

/** The last tie-break: the catalogue id, so equal credits still order one way. */
const byId = (a: PersonCredit, b: PersonCredit) =>
  a.mediaItemId < b.mediaItemId ? -1 : a.mediaItemId > b.mediaItemId ? 1 : 0;

/**
 * **Which of a person's credits lends the person page its hero** (founder QA P1-9).
 *
 * The page drew a plain Parchment band with the portrait straddling it, and that look
 * failed QA: a person page should open on their work the way a title page opens on the
 * film. Nothing new is fetched for it. The adapter already writes every credited title
 * into `media_items` with its `backdrop_path` (`fromSearchResult`), so the page only
 * reads one more column off rows it was already reading (`usePerson`).
 *
 * THE ORDER, AND WHY
 *
 *   1. **Their acting, not their appearances.** Cast credits only, and not a
 *      self-appearance — a talk show, the news, a reality programme, an awards
 *      ceremony (the adapter's `self` flag, the same one that keeps those out of the
 *      Cast half). A chat-show set is not "what they are in".
 *   2. **The most recently released.** Newest `releaseDate` that is on or before
 *      `today`, so an announced project with a date next year — usually a placeholder
 *      still, or nothing anybody has seen — never stands for them. An undated credit is
 *      not "released" either, for the same reason.
 *   3. **Then further down that list**, newest first: the order above simply continues.
 *      Every candidate already has a backdrop, so the first one is the answer; the
 *      fall-through is to the next rule, not to the next credit.
 *   4. **Then any of their work behind the camera that has a backdrop**, for a director,
 *      writer or producer with no on-screen work: the most recently released first, by
 *      the same rule, and only then an undated or upcoming one, most popular first. A
 *      backdrop of their own film is a truer hero than the band, even before it opens.
 *      A self-appearance is still excluded.
 *   5. **Else null**, and the page draws the branded band it always drew.
 *
 * Ties on the date — two films out the same day, or a series and a film — go to the
 * more popular credit (the cache's own `order`, lowest first), then to the catalogue
 * id, so the same filmography always picks the same picture.
 *
 * Pure, and `today` is a parameter (`YYYY-MM-DD`), so the rule is tested without a clock.
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

  const newest = (pool: PersonCredit[]) =>
    [...pool].sort(
      (a, b) =>
        // Newest first; both are `YYYY-MM-DD`, so the comparison is a string one.
        (b.releaseDate! < a.releaseDate! ? -1 : b.releaseDate! > a.releaseDate! ? 1 : 0) ||
        a.order - b.order ||
        byId(a, b),
    )[0] ?? null;

  const acting = credits.filter((credit) => credit.as === 'cast' && released(credit));
  if (acting.length) return newest(acting);

  const crew = credits.filter(
    (credit) => credit.crewRole !== null && Boolean(credit.backdropPath) && !credit.self,
  );
  const releasedCrew = crew.filter(released);
  if (releasedCrew.length) return newest(releasedCrew);
  // Undated or upcoming: the cache's popularity order, which `order` already is.
  if (crew.length) return [...crew].sort((a, b) => a.order - b.order || byId(a, b))[0]!;

  return null;
}
