/**
 * What a watch history *means*, in one file with no React and no network in it.
 *
 * `watch-history-and-ranking-calibration.md` §D.2, §J.2.
 *
 * The rules here are the ones the screen and the title line both have to agree on, and
 * the reason they live apart from either is that they disagreed once already: the
 * entry line and the screen header would each have decided independently what "first
 * watch" means and what counts as a rewatch, and the first divergence would have been
 * a screen saying *Watched 6 times* over five rows.
 */

/** Where a date came from, and how hard somebody asserted it (§D.1). */
export type WatchBasis = 'today_default' | 'reader' | 'diary' | 'unattributed' | 'none';

export type WatchEvent = {
  id: string;
  /** `YYYY-MM-DD`, or null when the viewing is known and its timing is not. */
  watchedOn: string | null;
  basis: WatchBasis;
  /** The Letterboxd diary URI, or that URI with `#prior`. Null for anything native. */
  importRef: string | null;
  recordedAt: string;
};

/**
 * The order §D.2 defines a rewatch by: undated first, then by date, then by recording.
 *
 * Undated events sort first because "watched at some point" is the oldest thing anybody
 * can say about a title — it is the viewing with no date *because* it is the one nobody
 * remembers, and putting it after this year's rewatch would read as the reader having
 * forgotten last Tuesday.
 *
 * `recordedAt` breaks a same-day tie, which is the only thing it is ever used for here.
 * It is a recording time and never a watch time (§D.0).
 */
export function inWatchOrder(events: readonly WatchEvent[]): WatchEvent[] {
  return [...events].sort((a, b) => {
    if (a.watchedOn === null && b.watchedOn !== null) return -1;
    if (a.watchedOn !== null && b.watchedOn === null) return 1;
    if (a.watchedOn !== null && b.watchedOn !== null && a.watchedOn !== b.watchedOn) {
      return a.watchedOn < b.watchedOn ? -1 : 1;
    }
    return a.recordedAt < b.recordedAt ? -1 : a.recordedAt > b.recordedAt ? 1 : 0;
  });
}

/**
 * The label a row carries.
 *
 * **"First watch" only when it is first *and* dated** (§D.2). An undated event is not a
 * first watch, because the reader has not told us it was first — it is the viewing they
 * cannot place, and it might be the tenth. It reads *Earlier*, which is the same word
 * the When row uses for the choice that produces it (T0b).
 */
export type WatchRowLabel = 'first' | 'rewatch' | 'earlier';

export function labelFor(events: readonly WatchEvent[], index: number): WatchRowLabel {
  const ordered = inWatchOrder(events);
  const event = ordered[index];
  if (!event) return 'rewatch';
  if (event.watchedOn === null) return 'earlier';

  /**
   * **"First" means the earliest DATED viewing, not index 0.**
   *
   * The undated viewings sort ahead of every date, so on a title with a `#prior` event
   * the earliest diary entry is at index 1 — and testing `index === 0` labelled it a
   * rewatch. §J.2's own wireframe settles it: `Jan 12 · First watch · Letterboxd` sits
   * directly above `Earlier · Date not recorded`, so the undated row does not take the
   * name away from the first date.
   *
   * Which is right on its own terms too. An undated viewing is the one nobody can place;
   * it cannot claim to be first, and it cannot stop anything else being the first thing
   * this history knows the date of.
   */
  const firstDated = ordered.findIndex((candidate) => candidate.watchedOn !== null);
  return index === firstDated ? 'first' : 'rewatch';
}

/** Whether the date came from an authoritative import, which the row says out loud. */
export const isFromDiary = (event: WatchEvent) => event.basis === 'diary';

/**
 * The count on the personal-context line, or null when the line says nothing new.
 *
 * **Never `Watched 1 time`** (§J.2, founder-locked). One viewing keeps the sentence the
 * page already had: the date, or nothing when there is no date. The plural count appears
 * from the second watch onward, which is also the first moment it says anything the date
 * alone did not.
 */
export function watchCountLabel(count: number): string | null {
  return count >= 2 ? `Watched ${count} times` : null;
}

/**
 * Whether the title line is tappable.
 *
 * **Any seen title**, because a single dated watch still has a date to edit and a past
 * watch to add. The chevron is the route; the words are whatever they already were.
 */
export const hasHistory = (count: number) => count >= 1;

/**
 * The years a history breaks into, newest first, with the undated viewings in their own
 * group at the end.
 *
 * `null` is the undated group's key, and it is last rather than first — the opposite of
 * `inWatchOrder`. The screen reads newest-first, so the viewing nobody can place is the
 * furthest thing from "what happened recently", and the wireframe in §J.2 puts *Earlier*
 * at the bottom under no year header at all.
 */
export function groupByYear(
  events: readonly WatchEvent[],
): { year: number | null; events: WatchEvent[] }[] {
  const newestFirst = inWatchOrder(events).reverse();
  const groups: { year: number | null; events: WatchEvent[] }[] = [];

  for (const event of newestFirst) {
    const year = event.watchedOn ? Number(event.watchedOn.slice(0, 4)) : null;
    const last = groups[groups.length - 1];
    if (last && last.year === year) last.events.push(event);
    else groups.push({ year, events: [event] });
  }

  return groups;
}

/**
 * The private movement sentence (§E.2, §B.2).
 *
 * **Private only, and exact at any depth.** `Moved from #118 → #72` on the reader's own
 * surfaces; nothing at all anywhere anybody else can see. The feed payload carries no
 * ordinal, so this function has no public counterpart to keep in step — which is the
 * point of putting the privacy rule in the data rather than in a template.
 */
export type Movement = {
  outcome: 'placed' | 'moved' | 'unchanged' | 'kept';
  fromPosition: number | null;
};

export function movementSentence(movement: Movement, position: number): string | null {
  switch (movement.outcome) {
    case 'moved':
      if (movement.fromPosition === null) return null;
      // A change of band can land on the same ordinal; "Moved from #4 → #4" says nothing.
      return movement.fromPosition === position
        ? `Still #${position}`
        : `Moved from #${movement.fromPosition} → #${position}`;
    // Both neighbours were checked and both held — or the reader skipped out, so nothing
    // moved it. Either way the reader's answer is the same one: it stayed (founder QA,
    // 2026-09-21: "a clear Still #X").
    case 'unchanged':
    case 'kept':
      return `Still #${position}`;
    case 'placed':
      return null;
    default:
      return null;
  }
}

/**
 * **The score of each watch — the opinion the reader held AT that watch** (founder delta QA,
 * 2026-09-21). Watch 1 → 9.0, Watch 2 → 8.3, Watch 3 → 8.3: exactly what the Feed shows.
 *
 * A pure Update your rating creates no watch and changes **no** watch's score; the current
 * score (title page, Collection, Search) is what moves. The placement ledger stays
 * append-only — this only reads it.
 *
 * The rule, in order, and why each source agrees with the Feed:
 *
 *   1. **The watch's own post.** A `title_ranked` post naming the watch carries
 *      `payload.score`, written by the finalize that placed it and never touched by a
 *      correction (20261015000100). This IS the Feed's number.
 *   2. **The watch's own ranking.** A `rewatch` placement tied to the watch — a backdated
 *      rewatch posts nothing, but its ranking still recorded the score.
 *   3. **The first watch's first ranking.** The earliest watch (in recording order) takes
 *      the first post that names no watch — the first ranking's post — or else the earliest
 *      `first` / `import` / `backfill` / `manual` placement.
 *   4. **Otherwise, the opinion held when it was logged.** A rewatch never re-ranked keeps
 *      the latest placement made before it was recorded, or the previous watch's score.
 *
 * A title never ranked has no scores at all, and a watch that maps to none draws no circle.
 */
export type WatchScore = { score: number; bucket: string | null };

export type LedgerPlacement = {
  kind: string;
  score: number;
  bucket?: string | null;
  watchEventId: string | null;
  createdAt: string;
};

export type WatchPost = {
  watchEventId: string | null;
  score: number | null;
  bucket: string | null;
  createdAt: string;
};

const FIRST_KINDS = new Set(['first', 'import', 'backfill', 'manual']);
const byTime = <T extends { createdAt: string }>(a: T, b: T) =>
  a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0;

export function scoresByWatch(
  events: readonly WatchEvent[],
  placements: readonly LedgerPlacement[],
  posts: readonly WatchPost[],
): Map<string, WatchScore> {
  const byRecording = [...events].sort((a, b) =>
    a.recordedAt < b.recordedAt ? -1 : a.recordedAt > b.recordedAt ? 1 : a.id < b.id ? -1 : 1,
  );
  const ledger = [...placements].sort(byTime);
  const scored = [...posts].filter((post) => post.score !== null).sort(byTime);
  const result = new Map<string, WatchScore>();

  // 1. The watch's own post.
  for (const post of scored) {
    if (post.watchEventId && byRecording.some((event) => event.id === post.watchEventId)) {
      result.set(post.watchEventId, { score: post.score as number, bucket: post.bucket });
    }
  }

  // 2. The watch's own ranking (the latest one tied to it).
  for (const event of byRecording) {
    if (result.has(event.id)) continue;
    const own = ledger.filter((p) => p.watchEventId === event.id && p.kind === 'rewatch').at(-1);
    if (own) result.set(event.id, { score: own.score, bucket: own.bucket ?? null });
  }

  // 3. The first watch's first ranking.
  const first = byRecording[0];
  if (first && !result.has(first.id)) {
    const post = scored.find((candidate) => candidate.watchEventId === null);
    const placement = ledger.find((candidate) => FIRST_KINDS.has(candidate.kind));
    if (post) result.set(first.id, { score: post.score as number, bucket: post.bucket });
    else if (placement) {
      result.set(first.id, { score: placement.score, bucket: placement.bucket ?? null });
    }
  }

  // 4. Otherwise, the opinion held when it was logged.
  byRecording.forEach((event, index) => {
    if (result.has(event.id)) return;
    const held = ledger.filter((p) => p.createdAt < event.recordedAt).at(-1);
    if (held) {
      result.set(event.id, { score: held.score, bucket: held.bucket ?? null });
      return;
    }
    const previous = byRecording[index - 1];
    const carried = previous ? result.get(previous.id) : undefined;
    if (carried) result.set(event.id, carried);
  });

  return result;
}

/** Which way the arrow points beside a movement, or null when there is none. */
export function movementDirection(
  movement: Movement,
  position: number,
): 'up' | 'down' | null {
  if (movement.outcome !== 'moved' || movement.fromPosition === null) return null;
  // A smaller ordinal is higher in the list.
  if (position < movement.fromPosition) return 'up';
  if (position > movement.fromPosition) return 'down';
  return null;
}
