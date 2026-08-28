import { supabase } from '@/lib/supabase';

/**
 * Recording that a slate was put in front of somebody.
 *
 * ---------------------------------------------------------------------------
 * THE FOUNDER'S CONSTRAINT, ANSWERED TWICE
 *
 * "Do not record a server write for every render/re-render accidentally." There are two
 * defences and only the second one is a guarantee:
 *
 *   **here** — a wall is written once per distinct id set. `sent` remembers what each
 *   wall last posted, so a re-render with the same twenty titles posts nothing, and a
 *   wall that grows by a page posts the whole new set once.
 *
 *   **on the server** — `note_recommendations_shown` truncates `shown_at` to the hour
 *   before inserting, so the primary key collapses everything inside one hour into one
 *   row per title. A render loop that defeated the guard above would still write nothing.
 *
 * The first is an optimisation and the second is the contract. Written in that order
 * deliberately: the guard here is the one that can be wrong, so it must not be the one
 * anything depends on.
 *
 * ---------------------------------------------------------------------------
 * WHAT COUNTS AS SHOWN
 *
 * **Included in a slate the client rendered.** Not "scrolled past a visibility
 * threshold": that would put a second definition of "shown" inside a layout, where it
 * would be untestable and would differ between the two walls. The founder asked for
 * whichever rule is reliably testable, and a delivered list is a list this module can
 * name.
 *
 * The whole wall, not the visible first nine — the same rule `noteSlateOnScreen` follows
 * and for the same reason: a reader who scrolls has seen the twentieth poster, and a
 * wall that only counted what fitted on screen would keep re-offering the bottom half as
 * though it were new.
 *
 * ---------------------------------------------------------------------------
 * FAILURE IS SILENT, ON PURPOSE
 *
 * This is a background fact about ordering. A reader whose impression write failed gets
 * a slightly less rotated wall next launch; a reader shown an error about it gets
 * nothing useful and one more thing to dismiss. Nothing on screen waits for this and
 * nothing reads its result.
 */

/**
 * Which titles each wall has already recorded. Process-lifetime.
 *
 * **A set per wall, not a fingerprint of the wall.** The first version stored one hash of
 * the (truncated) id list, and independent review found the hole: `diversifyPaged`
 * preserves its prefix, so growing a wall from sixty items to a hundred leaves the first
 * sixty — and therefore the hash — unchanged. The guard matched, the call returned early,
 * and titles 61–100 were **never recorded at all**, so the pages a reader had to work
 * hardest to reach were the ones with no durable cooldown.
 *
 * Tracking the ids themselves makes growth expressible: what gets sent is whatever this
 * wall has not sent yet, which is the right answer whether the wall grew, shrank, or was
 * rearranged.
 */
const sent = new Map<string, Set<string>>();

/** Matches `foryou.impression_batch_max`, which the server refuses above. */
const BATCH_MAX = 60;

/** Enough for both media across a few filter combinations; older walls fall off. */
const KEYS = 8;

const remember = (key: string) => {
  const existing = sent.get(key);
  if (existing) return existing;

  const fresh = new Set<string>();
  sent.set(key, fresh);
  // Bounded like `onScreen` in `session-seed.ts`, and for the same reason: a reader who
  // tries twenty filter combinations should not grow this without limit.
  while (sent.size > KEYS) {
    const oldest = sent.keys().next();
    if (oldest.done) break;
    sent.delete(oldest.value);
  }
  return fresh;
};

/**
 * Record whatever of this wall has not been recorded yet.
 *
 * `key` is the wall — medium and filters — rather than the query key, for the reason
 * `wallKey` carries in `use-for-you.ts`: a query key moves whenever a ranking does, and
 * an impression guard keyed on it would re-post the same wall after every log.
 *
 * Sent in chunks, because the server refuses a batch above `foryou.impression_batch_max`
 * — so a five-page wall is two calls rather than one truncation. Chunking is what makes
 * the whole wall recordable; slicing was what made it silently partial.
 */
export async function noteImpressions(key: string, mediaItemIds: readonly string[]) {
  if (mediaItemIds.length === 0) return;

  const already = remember(key);
  const fresh = [...new Set(mediaItemIds)].filter((id) => !already.has(id));
  if (fresh.length === 0) return;

  // Marked *before* the await, not after. Two renders can reach this line before either
  // request settles, and marking on success would let both through — which the server
  // deduplicates, but at the cost of the round trip this guard exists to avoid.
  for (const id of fresh) already.add(id);

  for (let start = 0; start < fresh.length; start += BATCH_MAX) {
    const chunk = fresh.slice(start, start + BATCH_MAX);
    try {
      const { error } = await supabase.rpc('note_recommendations_shown', {
        p_media_item_ids: chunk,
      });
      // A refusal means nothing in this chunk was stored, so those ids are forgotten and
      // the next render may offer them again. Only the chunk that failed — the ones
      // already committed are still recorded, and re-sending them would be a round trip
      // to be told what the primary key already knows.
      if (error) for (const id of chunk) already.delete(id);
    } catch {
      for (const id of chunk) already.delete(id);
    }
  }
}

/** Test seam. Nothing in the app calls this. */
export function resetImpressions() {
  sent.clear();
}
