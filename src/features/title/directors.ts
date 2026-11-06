/**
 * The Cinematic title module's director line (title-page sprint, 2026-11-06): quiet
 * metadata under the year, certification and runtime, for a film only.
 *
 *     Directed by Christian Alvart
 *     Directed by Daniel Kwan and Daniel Scheinert
 *     Directed by Christopher Nolan, Emma Thomas and 1 more
 *
 * Two names are both shown; past two, the first two and a count, so the line stays one
 * statement about the film rather than a credit roll. The spoken form names everyone.
 * Nothing at all when there is no Director credit: no empty state, no placeholder.
 */
export function directedBy(names: readonly string[]): { text: string; label: string } | null {
  const people = names.map((name) => name.trim()).filter(Boolean);
  if (people.length === 0) return null;
  const all = joinNames(people);
  if (people.length <= 2) return { text: `Directed by ${all}`, label: `Directed by ${all}` };
  const rest = people.length - 2;
  return {
    text: `Directed by ${people[0]}, ${people[1]} and ${rest} more`,
    label: `Directed by ${all}`,
  };
}

const joinNames = (people: readonly string[]) =>
  people.length <= 1
    ? (people[0] ?? '')
    : `${people.slice(0, -1).join(', ')} and ${people[people.length - 1]}`;
