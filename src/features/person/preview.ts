/**
 * **Who was just tapped**, so a person page can say their name before its reads answer.
 *
 * A cast rail and a people search have the person's name and portrait on screen at the
 * moment of the tap. The person page used to throw that away and draw a blank identity
 * until `person_cache` and the credited titles had both answered: about a third of a
 * second when the filmography is cached, and more than a second when it has to be fetched.
 * So the entry points write what they already showed here, just before they navigate, and
 * the page's loading state reads it back.
 *
 * What this is, and what it is deliberately not:
 *
 *   - **Public TMDB credit data the reader already saw**: a name and a profile path. No
 *     account, no library state, nothing about the reader.
 *   - **Not a cache of the person.** It never feeds `usePerson`, the decision to ask the
 *     adapter, the claim wait, or any error or empty state. The page draws it only while
 *     loading, and the person's own record replaces it the moment it arrives.
 *   - **In memory only**, never persisted, and bounded: the last {@link LIMIT} people.
 *   - **Keyed by the route id exactly**, so a preview is only ever drawn for the person
 *     whose page it is.
 */
export type PersonPreview = { name: string; profilePath: string | null };

/** Enough for any realistic back-and-forth through cast rails; small enough not to matter. */
const LIMIT = 50;

const previews = new Map<string, PersonPreview>();

/** Remember the person about to be opened. Call it just before `router.push`. */
export function rememberPersonPreview(personId: string | number, preview: PersonPreview) {
  const key = String(personId);
  const name = preview.name.trim();
  if (!key || !name) return;
  // Re-inserted, so the Map's insertion order is least recently remembered first.
  previews.delete(key);
  previews.set(key, { name, profilePath: preview.profilePath ?? null });
  while (previews.size > LIMIT) {
    const oldest = previews.keys().next().value;
    if (oldest === undefined) break;
    previews.delete(oldest);
  }
}

/** The preview for exactly this route id, or null. */
export function personPreview(personId: string | null | undefined): PersonPreview | null {
  if (!personId) return null;
  return previews.get(String(personId)) ?? null;
}

/** For tests: start from nothing remembered. */
export function forgetPersonPreviews() {
  previews.clear();
}
