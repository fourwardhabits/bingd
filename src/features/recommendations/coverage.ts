/**
 * Engine V2's catalogue source, as a gap filler (founder spec 2026-11-10, A1).
 *
 * `catalogue_candidates` returns titles in the languages and decades a reader's profile
 * says they engage with. Adding all of them to every pool would be popularity padding
 * under another name — an English reader's "English" source is forty popular English
 * films — and an anchored wall must not be padded (review of 2026-09-13, M2). So the
 * catalogue only **fills a shortfall**: for each source language and decade, it adds
 * titles until the pool holds that facet's fair share, and not one more.
 *
 * A facet's fair share is its share of the reader's positive evidence, applied to the
 * pool as the anchors' lists built it, with a floor so a minority language always gets
 * enough candidates for selection to have a real choice. A reader whose four loved
 * Japanese films are 8% of their band gets at least {@link MIN_PER_FACET} Japanese
 * candidates whatever TMDB's lists held; the reader whose lists are already full of
 * Japanese cinema gets none.
 */
import type { Candidate } from './rank';
import { decadeOf, type Profile } from './profile';

/** The fewest candidates a source facet is guaranteed in the pool, if the catalogue has them. */
export const MIN_PER_FACET = 6;
/** The most the catalogue may add for one facet, however large its share. */
export const MAX_PER_FACET = 20;

type Facet = { key: string; target: number; matches: (candidate: Candidate) => boolean };

/** Shares of the reader's positive evidence, for the facets the source was asked about. */
function languageShares(profile: Profile, languages: readonly string[]): Map<string, number> {
  const positive = (code: string) => {
    const facet = profile.languages.get(code);
    return facet ? facet.titles * Math.max(0, facet.mean + 1) : 0;
  };
  let total = 0;
  for (const [code] of profile.languages) total += positive(code);
  return new Map(languages.map((code) => [code, total > 0 ? positive(code) / total : 0]));
}

function eraShares(
  profile: Profile,
  kind: 'movie' | 'series',
  decades: readonly number[],
): Map<number, number> {
  const eras = profile.eras[kind];
  let total = 0;
  for (const [, facet] of eras) total += facet.titles;
  return new Map(decades.map((decade) => [decade, total > 0 ? (eras.get(decade)?.titles ?? 0) / total : 0]));
}

/**
 * The catalogue rows worth adding to `pool`, in the order they should be considered.
 *
 * Pure. `pool` is every candidate the other sources produced, before eligibility; a row
 * already in it is never added twice. Rows are taken per facet in the server's order, and
 * a row serving two facets (a Japanese film of a loved decade) counts toward both.
 */
export function coverageFill(
  pool: readonly Candidate[],
  catalogue: readonly Candidate[],
  profile: Profile,
  request: { kind: 'movie' | 'series'; languages: readonly string[]; decades: readonly number[] },
): Candidate[] {
  if (catalogue.length === 0) return [];

  const size = pool.length;
  const target = (share: number) =>
    Math.min(MAX_PER_FACET, Math.max(MIN_PER_FACET, Math.ceil(share * size)));
  const facets: Facet[] = [];
  for (const [code, share] of languageShares(profile, request.languages)) {
    facets.push({ key: `language:${code}`, target: target(share), matches: (c) => c.language === code });
  }
  for (const [decade, share] of eraShares(profile, request.kind, request.decades)) {
    facets.push({
      key: `era:${decade}`,
      target: target(share),
      matches: (c) => decadeOf(c.year) === decade,
    });
  }

  const present = new Set(pool.map((candidate) => candidate.mediaItemId));
  const have = new Map(facets.map((facet) => [facet.key, pool.filter(facet.matches).length]));
  const added: Candidate[] = [];

  for (const facet of facets) {
    for (const row of catalogue) {
      if ((have.get(facet.key) ?? 0) >= facet.target) break;
      if (present.has(row.mediaItemId) || !facet.matches(row)) continue;
      present.add(row.mediaItemId);
      added.push(row);
      for (const other of facets) {
        if (other.matches(row)) have.set(other.key, (have.get(other.key) ?? 0) + 1);
      }
    }
  }
  return added;
}
