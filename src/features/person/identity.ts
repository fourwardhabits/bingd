/**
 * **The one line of context under a person's name** (founder spec §6, 2026-11-13).
 *
 * The page said `Acting · born 1974 · Los Angeles, California, USA`: a department, a year
 * and a full birthplace, which is three facts where the founder wants at most two and
 * the hierarchy name → biography → filmography. So: the birth year and the country,
 * `Born 1959 · Japan`, and nothing else.
 *
 *   - **Year:** `Born YYYY`; with a death date, the span `1931–2019` instead, because
 *     "born" beside a life that has ended reads as an omission. A death date alone is
 *     `Died YYYY`.
 *   - **Country:** the last comma-separated part of TMDB's `place_of_birth`, which is
 *     where TMDB writes the country (`Shawnee, Oklahoma, USA` → `USA`). Omitted when
 *     there is no place, rather than guessed.
 *   - **Neither:** null, and the page draws no line at all — never a dash.
 *
 * The department (`Acting`) is gone: the Cast / Crew tabs below already say it.
 */
export function birthLine(person: {
  birthday: string | null;
  deathday: string | null;
  placeOfBirth: string | null;
}): string | null {
  const born = yearOf(person.birthday);
  const died = yearOf(person.deathday);
  const years =
    born && died ? `${born}–${died}` : born ? `Born ${born}` : died ? `Died ${died}` : null;
  const country = countryOf(person.placeOfBirth);
  return [years, country].filter(Boolean).join(' · ') || null;
}

/** `YYYY` from TMDB's `YYYY-MM-DD`, or null for anything that does not start with a year. */
const yearOf = (date: string | null): string | null =>
  date && /^\d{4}/.test(date) ? date.slice(0, 4) : null;

/** The last comma-separated part of a birthplace, trimmed, or null. */
export function countryOf(place: string | null): string | null {
  if (!place) return null;
  const last = place.split(',').at(-1)?.trim();
  return last ? last : null;
}
