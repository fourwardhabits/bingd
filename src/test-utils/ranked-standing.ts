import type { RankedEntry } from '@/features/collection/use-collection';

/**
 * **An authoritative ranking, for tests of what a summary says** (QA corrections,
 * 2026-11-06).
 *
 * A ranking summary now reads the whole category afresh and derives every title's place
 * and score from it, so a test has to say what the ranking *is*, not what one placement
 * returned. This builds one: three contiguous bands of the given sizes (I liked it, then
 * It was fine, then I didn't like it), the named titles at their positions, and filler
 * titles everywhere else. Only the columns the summary reads are filled.
 *
 *     rankingOf({ loved: 23 }, { allied: 9, 'pitch-black': 10 })
 */
export function rankingOf(
  sizes: { loved?: number; fine?: number; not_for_me?: number },
  at: Record<string, number>,
): RankedEntry[] {
  const loved = sizes.loved ?? 0;
  const fine = sizes.fine ?? 0;
  const total = loved + fine + (sizes.not_for_me ?? 0);
  const byPosition = new Map<number, string>();
  for (const [id, position] of Object.entries(at)) {
    if (position < 1 || position > total) {
      throw new Error(`rankingOf: ${id} at #${position} is outside a ranking of ${total}`);
    }
    if (byPosition.has(position)) {
      throw new Error(`rankingOf: two titles at #${position}; positions are unique`);
    }
    byPosition.set(position, id);
  }
  return Array.from({ length: total }, (_, i) => {
    const position = i + 1;
    const bucket = position <= loved ? 'loved' : position <= loved + fine ? 'fine' : 'not_for_me';
    const id = byPosition.get(position) ?? `filler-${position}`;
    return { mediaItemId: id, title: id, position, bucket } as unknown as RankedEntry;
  });
}
