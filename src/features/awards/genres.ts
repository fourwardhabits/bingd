/**
 * A genre vocabulary the awards can count, over a catalogue that has two of them.
 *
 * `media_items.genres` is not one thing. The alpha catalogue is Wikidata-seeded
 * (`20260814001131`) and its labels are lower-case and verbose — `drama film`,
 * `romantic comedy film`, `post-apocalyptic film`, `neo-noir`, `huis-clos film`. A
 * title the TMDB adapter has enriched carries TMDB's own names instead — `Drama`,
 * `Science Fiction`, `Horror`. Both are in the same column at the same time, and which
 * one a given row has depends on whether an enrichment has run against it.
 *
 * So an award that asked `genres.includes('Horror')` would count almost nothing on a
 * fresh install and slowly start counting as rows enriched. That is not a slow rollout,
 * it is a number that moves for a reason the user cannot see.
 *
 * Two rules follow, and both are here rather than in the tracks:
 *
 * **Matching is by word, not by equality.** `horror film`, `Horror` and `psychological
 * horror` are one genre. The patterns below are word-boundary regexes over a lower-cased
 * label, which is the smallest thing that reads both vocabularies.
 *
 * **Counting distinct genres uses this list and nothing else.** Wikidata gives `12 Angry
 * Men` three labels — `drama film`, `huis-clos film`, `trial film` — and a "distinct
 * genres" award over raw labels would call that a third of a collection's variety from
 * one film. Genre Gremlin counts how many of *these eighteen* a collection touches,
 * which is a number that means the same thing on an enriched catalogue and a seeded one.
 *
 * A label matching nothing here contributes nothing. That is deliberate: the alternative
 * is a vocabulary that grows every time Wikidata invents a phrase, and thresholds that
 * mean something different each time it does.
 */

/**
 * The eighteen. TMDB's own genre list, minus the two it splits by medium — `Action &
 * Adventure` and `Sci-Fi & Fantasy` are TV spellings of pairs already here.
 */
export const CANONICAL_GENRES = [
  'Action',
  'Adventure',
  'Animation',
  'Comedy',
  'Crime',
  'Documentary',
  'Drama',
  'Family',
  'Fantasy',
  'History',
  'Horror',
  'Music',
  'Mystery',
  'Romance',
  'Science Fiction',
  'Thriller',
  'War',
  'Western',
] as const;

export type CanonicalGenre = (typeof CANONICAL_GENRES)[number];

/**
 * One pattern per genre, read against a lower-cased label.
 *
 * Written to admit the Wikidata phrasings this catalogue actually holds rather than to
 * be exhaustive about English. `\b` on both ends keeps `warm` out of War and `historic`
 * inside History; `documentar` covers both `documentary` and `documentaries`.
 */
const PATTERNS: Record<CanonicalGenre, RegExp> = {
  Action: /\baction\b/,
  Adventure: /\badventure\b/,
  // `anime` is here because the catalogue uses it as a genre label, and Toon Bloom is
  // about drawn things. Anime as a *filter* is a different rule and stays in
  // `collection/filters.ts`: Japanese original language and an animation genre.
  Animation: /\banimat(ed|ion)\b|\banime\b|\bcartoon\b/,
  Comedy: /\bcomed(y|ies|ic)\b/,
  Crime: /\bcrime\b|\bheist\b|\bgangster\b/,
  Documentary: /\bdocumentar/,
  Drama: /\bdrama\b|\bmelodrama\b/,
  Family: /\bfamily\b|\bchildren'?s\b/,
  Fantasy: /\bfantas(y|tique)\b|\bsword and sorcery\b/,
  History: /\bhistor(y|ical)\b|\bperiod (piece|drama)\b|\bbiographical\b/,
  Horror: /\bhorror\b|\bslasher\b/,
  // `music(al)?`, not `musical?` — the second matches "musica" and "musical" and
  // misses the word "Music" entirely, which is how TMDB spells the genre.
  Music: /\bmusic(al)?\b|\bconcert film\b/,
  Mystery: /\bmyster(y|ies)\b|\bdetective\b|\bwhodunn?it\b/,
  Romance: /\bromance\b|\bromantic\b/,
  'Science Fiction': /\bscience fiction\b|\bsci-?fi\b|\bdystopian\b|\bpost-apocalyptic\b|\bspace opera\b/,
  Thriller: /\bthriller\b|\bsuspense\b|\bneo-noir\b|\bfilm noir\b/,
  War: /\bwar\b|\bmilitary\b/,
  Western: /\bwestern\b/,
};

/**
 * Which of the eighteen a title's labels amount to.
 *
 * A set, so a title labelled `comedy drama` and `romantic comedy film` yields Comedy
 * once. That is the same rule the awards state — no title counted twice for having two
 * names for one genre — expressed where it cannot be forgotten.
 */
export function canonicalGenres(labels: readonly string[] | null | undefined): Set<CanonicalGenre> {
  const found = new Set<CanonicalGenre>();
  for (const raw of labels ?? []) {
    const label = raw?.toLowerCase?.();
    if (!label) continue;
    for (const genre of CANONICAL_GENRES) {
      if (PATTERNS[genre].test(label)) found.add(genre);
    }
  }
  return found;
}

/** Whether a title belongs to any of the given genres. One title, one yes. */
export function hasAnyGenre(
  labels: readonly string[] | null | undefined,
  genres: readonly CanonicalGenre[],
): boolean {
  const found = canonicalGenres(labels);
  return genres.some((genre) => found.has(genre));
}
