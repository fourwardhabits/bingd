import { franchiseKey, maxPerAnchor, maxPerFranchise, unitRandom, type Scored } from './rank';

/**
 * For You V2: which scored candidates go on the wall, and in what order (2026-09-13).
 *
 * ---------------------------------------------------------------------------
 * WHY THIS REPLACES `diversifyPaged` ON THE WALL
 *
 * The physical pass on #145 found the wall still repetitive, and the V2 evaluation on real
 * production rankings (aggregates only, `recommendations.md` §11) found why:
 *
 *   - **The score is not a certainty.** Held out of a reader's own history, the content
 *     score ordered clearly-separated loved-versus-disliked films no better than chance,
 *     and membership of an anchor's TMDB list was not more likely for loved titles. A
 *     computed #1 is a neighbourhood, not a verdict.
 *   - **Exposure only reordered the top sixty**, used absolute tiers from a 72-hour count,
 *     and forgot everything at the window's edge: a reader who returned every four days saw
 *     three quarters of the same wall.
 *
 * So the wall is now drawn in three steps.
 *
 * 1. **A qualified pool** ({@link qualifiedPool}): every candidate scoring at least
 *    `qualifyRatio` of the score at `frontierRank` — the first page's quality frontier —
 *    bounded to `[minPool, maxPool]`. Relative to *this reader's* frontier, so a thin taste
 *    and a rich one both get a neighbourhood of genuinely comparable titles, and a tail whose
 *    relevance has fallen off is left out rather than sampled.
 * 2. **Score-weighted sampling without replacement** inside it: each candidate's key is
 *    `score / τ − exposure penalty + Gumbel(seed, id)`, with τ a fraction of the pool's own
 *    score spread. Stronger titles are genuinely more likely to lead; none is guaranteed a
 *    permanent slot; it is never uniform.
 * 3. **Light slate diversity**: a soft penalty per primary-genre title beyond four on a
 *    page, and per repeated lead anchor — no quotas, so a horror reader still gets a horror
 *    wall — plus the two hard ceilings that stop accidental duplicates (four per
 *    anchor, two per franchise) exactly as before.
 *
 * Only when the qualified pool cannot fill the pages asked for does the wall continue into
 * the rest, in strict score order and under the same hard ceilings. Nothing is padded.
 *
 * Scores and explanations are untouched: this module only chooses and orders, so every
 * "Because you loved X" on the wall is the same claim `scoreCandidate` made.
 */

/** A title's durable exposure, as `recommendation_exposure` returns it. */
export type ExposureEntry = {
  /** Distinct hours inside the server's window in which it was on this reader's wall. */
  count: number;
  /** The latest of those, epoch ms. */
  lastShownAt: number;
};

/**
 * Every tuning constant in one reviewable place, with the evidence for each.
 *
 * Chosen by simulation on real production profiles — First Five, ~20, ~60 and 100+ ranked
 * films — over cold sessions 6, 24, 48 and 96 hours apart (`recommendations.md` §11).
 */
export const FOR_YOU_SELECTION = {
  /** The first page's last slot is the quality frontier the pool is measured against. */
  frontierRank: 20,
  /** Qualified: at least 80% of the frontier score. 0.85 left First Five walls too narrow. */
  qualifyRatio: 0.8,
  /**
   * Never sample from fewer than three walls' worth, nor from more than eight. Sixty was the
   * old engine's pool, and a steep profile that clamped to forty ran out of unseen titles by
   * the second Refresh (independent review of V2, M1).
   */
  minPool: 60,
  maxPool: 160,
  /**
   * When fewer than `minPool` qualified titles remain unseen, the pool extends into the rest
   * in score order — but never below this share of the frontier, so a tail whose relevance has
   * fallen off is still never sampled. The trigger is a constant, never the number of pages
   * asked for: growing the wall must not change the pool the visible prefix was drawn from
   * (second review of V2, B1). A first cold wall has nothing seen and never extends.
   */
  extendRatio: 0.6,
  /**
   * τ as a fraction of the pool's score spread. 0.15 kept first-wall relevance within 2% of
   * strict order; 0.25–0.35 cost 3–8%.
   */
  temperature: 0.15,
  /** Exposure halves every four days: moderately suppressed after a few days, gone in weeks. */
  exposureHalfLifeHours: 96,
  /** Log-weight units per unit of decayed exposure (`log2(1 + count)`). */
  exposureStrength: 3,
  /**
   * Shown within the last 18 hours: near-absolute suppression on top of the decay, so the
   * same day never shows the same wall twice while next-day opens still let a strong title
   * return. 30 hours drove next-day recurrence to zero, which the founder ruled out.
   */
  recentHours: 18,
  recentPenalty: 12,
  /**
   * On screen when Refresh was pressed: worse than anything merely seen earlier today, so a
   * Refresh never hands back the wall the reader just asked to replace — the old engine's
   * `current` tier, kept (independent review of V2, M1). The caller passes `current` only for
   * a Refresh; a return after hours away relies on the decayed and recent penalties instead.
   */
  onScreenPenalty: 24,
  /** Four of one primary genre are free on a page; each one after that costs this much more. */
  genreFreeCount: 4,
  genreRepeatPenalty: 0.4,
  /** Each earlier title on the page with the same lead anchor costs this much. */
  anchorRepeatPenalty: 0.25,
} as const;

export type SelectionConfig = { [K in keyof typeof FOR_YOU_SELECTION]: number };

const HOUR_MS = 3_600_000;

/** The candidates worth sampling from, best first, and everything else in score order. */
export function qualifiedPool(
  scored: readonly Scored[],
  config: SelectionConfig = FOR_YOU_SELECTION,
  /**
   * How many unseen titles the pool should hold, and which titles count as recently seen.
   * Omitted, the pool is the plain quality neighbourhood.
   */
  shortfall?: { need: number; recent: (item: Scored) => boolean },
): { pool: Scored[]; rest: Scored[]; baseSize: number } {
  const byScore = [...scored].sort(
    (a, b) => b.explanation.total - a.explanation.total || a.mediaItemId.localeCompare(b.mediaItemId),
  );
  if (byScore.length === 0) return { pool: [], rest: [], baseSize: 0 };

  const frontier = byScore[Math.min(config.frontierRank, byScore.length) - 1]!.explanation.total;
  const qualified = byScore.filter((item) => item.explanation.total >= frontier * config.qualifyRatio).length;
  let size = Math.max(Math.min(config.minPool, byScore.length), Math.min(qualified, config.maxPool));
  const baseSize = size;

  if (shortfall) {
    let unseen = byScore.slice(0, size).filter((item) => !shortfall.recent(item)).length;
    while (
      unseen < shortfall.need &&
      size < Math.min(byScore.length, config.maxPool) &&
      byScore[size]!.explanation.total >= frontier * config.extendRatio
    ) {
      if (!shortfall.recent(byScore[size]!)) unseen += 1;
      size += 1;
    }
  }
  return { pool: byScore.slice(0, size), rest: byScore.slice(size), baseSize };
}

/**
 * How stale a title is, in log-weight units. Zero for a title never shown.
 *
 * `durable` is the server's record (read once per session), `sessionShownAt` this process's
 * own (Refresh and resume); the larger decayed value wins, so the two halves are not
 * double-counted. Finite for every input — no title is ever blacklisted.
 */
export function exposurePenalty(
  durable: ExposureEntry | undefined,
  sessionShownAt: number | undefined,
  now: number,
  config: SelectionConfig = FOR_YOU_SELECTION,
): number {
  let decayed = 0;
  let latest = Number.NEGATIVE_INFINITY;
  if (durable) {
    const age = Math.max(0, now - durable.lastShownAt) / HOUR_MS;
    decayed = Math.log2(1 + durable.count) * 0.5 ** (age / config.exposureHalfLifeHours);
    latest = durable.lastShownAt;
  }
  if (sessionShownAt != null) {
    const age = Math.max(0, now - sessionShownAt) / HOUR_MS;
    decayed = Math.max(decayed, 0.5 ** (age / config.exposureHalfLifeHours));
    latest = Math.max(latest, sessionShownAt);
  }
  if (!Number.isFinite(latest)) return 0;
  const recent = (now - latest) / HOUR_MS < config.recentHours ? config.recentPenalty : 0;
  return config.exposureStrength * decayed + recent;
}

const gumbel = (seed: number, id: string) => -Math.log(-Math.log(unitRandom(seed, id)));

export type DrawInput = {
  pageSize: number;
  pages: number;
  /** The arrangement's seed: same seed, same inputs, same wall. */
  seed: number;
  /** The arrangement's start, epoch ms — never `Date.now()`, so a re-render cannot move it. */
  now: number;
  durable?: ReadonlyMap<string, ExposureEntry>;
  session?: ReadonlyMap<string, number>;
  /** On screen when the arrangement began (Refresh or resume): always drawn last. */
  current?: ReadonlySet<string>;
  /**
   * Titles the reader vetoed. Removed **inside** the draw rather than before it, so the
   * quality frontier and τ are those of the whole scoring and dismissing one title replaces
   * that title rather than rescaling every other title's odds.
   */
  veto?: ReadonlySet<string>;
  config?: SelectionConfig;
};

/**
 * The wall: `pages × pageSize` titles at most, drawn as the header describes.
 *
 * Pages are drawn in sequence and the sequence does not depend on how many pages were asked
 * for, so growing the wall never moves what the reader has already scrolled past. The soft
 * penalties and the hard ceilings count per page — the diversity contract is per screenful,
 * as it always was.
 */
export function drawSlate(scored: readonly Scored[], input: DrawInput): Scored[] {
  const config = input.config ?? FOR_YOU_SELECTION;
  const limit = Math.max(1, input.pages) * input.pageSize;
  const penaltyOf = (item: Scored) =>
    exposurePenalty(input.durable?.get(item.mediaItemId), input.session?.get(item.mediaItemId), input.now, config) +
    (input.current?.has(item.mediaItemId) ? config.onScreenPenalty : 0);
  // Neither the number of pages nor a veto may change the pool: the first would move the
  // visible prefix as the wall grows, the second would rescale every title's odds on a
  // dismissal. Only what the reader has genuinely seen extends it.
  const { pool, rest, baseSize } = qualifiedPool(scored, config, {
    need: config.minPool,
    recent: (item) => penaltyOf(item) >= config.recentPenalty,
  });
  if (pool.length === 0) return [];

  // τ from the unextended pool, so an extension adds competitors without rescaling the keys
  // of the titles that were already there.
  const top = pool[0]!.explanation.total;
  const bottom = pool[Math.max(0, baseSize - 1)]!.explanation.total;
  const tau = Math.max(1e-6, config.temperature * Math.max(top - bottom, 0.02));

  /**
   * Everything the pick loop reads, computed once per title (independent review of V2, M2).
   * `franchiseKey` normalises and runs regexes; recomputing it for every candidate on every
   * pick made a five-page draw 3–8× the old engine's cost on the JS thread.
   */
  type Entry = {
    item: Scored;
    key: number;
    franchise: string | null;
    genre: string | null;
    lead: string | null;
    anchors: readonly string[];
  };
  const entryOf = (item: Scored, key: number): Entry => ({
    item,
    key,
    franchise: franchiseKey(item.title),
    genre: item.genres[0] ?? null,
    lead: item.explanation.anchors[0]?.mediaItemId ?? null,
    anchors: item.explanation.anchors.map((hit) => hit.mediaItemId),
  });
  const vetoed = (item: Scored) => input.veto?.has(item.mediaItemId) === true;

  const keyed: Entry[] = pool
    .filter((item) => !vetoed(item))
    .map((item) =>
      entryOf(item, item.explanation.total / tau - penaltyOf(item) + gumbel(input.seed, item.mediaItemId)),
    );
  const tail: Entry[] = rest.filter((item) => !vetoed(item)).map((item) => entryOf(item, 0));
  const anchorCap = maxPerAnchor();
  const franchiseCap = maxPerFranchise();

  const wall: Scored[] = [];

  while (wall.length < limit && (keyed.length > 0 || tail.length > 0)) {
    const perGenre = new Map<string, number>();
    const perAnchor = new Map<string, number>();
    const perLead = new Map<string, number>();
    const perFranchise = new Map<string, number>();
    let pageCount = 0;

    const blocked = (entry: Entry) => {
      if (entry.franchise != null && (perFranchise.get(entry.franchise) ?? 0) >= franchiseCap) return true;
      for (const anchor of entry.anchors) if ((perAnchor.get(anchor) ?? 0) >= anchorCap) return true;
      return false;
    };
    const take = (entry: Entry) => {
      wall.push(entry.item);
      pageCount += 1;
      if (entry.genre) perGenre.set(entry.genre, (perGenre.get(entry.genre) ?? 0) + 1);
      if (entry.franchise != null) perFranchise.set(entry.franchise, (perFranchise.get(entry.franchise) ?? 0) + 1);
      for (const anchor of entry.anchors) perAnchor.set(anchor, (perAnchor.get(anchor) ?? 0) + 1);
      if (entry.lead) perLead.set(entry.lead, (perLead.get(entry.lead) ?? 0) + 1);
    };

    // The qualified pool first, by penalised key.
    while (pageCount < input.pageSize && keyed.length > 0) {
      let best = -1;
      let bestKey = Number.NEGATIVE_INFINITY;
      for (let index = 0; index < keyed.length; index += 1) {
        const entry = keyed[index]!;
        if (blocked(entry)) continue;
        const penalty =
          config.genreRepeatPenalty *
            Math.max(0, (entry.genre ? (perGenre.get(entry.genre) ?? 0) : 0) - config.genreFreeCount + 1) +
          config.anchorRepeatPenalty * (entry.lead ? (perLead.get(entry.lead) ?? 0) : 0);
        if (entry.key - penalty > bestKey) {
          bestKey = entry.key - penalty;
          best = index;
        }
      }
      if (best < 0) break;
      take(keyed.splice(best, 1)[0]!);
    }

    // Then the rest, in score order, only if the pool could not fill this page.
    for (let index = 0; pageCount < input.pageSize && index < tail.length; ) {
      const entry = tail[index]!;
      if (blocked(entry)) {
        index += 1;
        continue;
      }
      take(entry);
      tail.splice(index, 1);
    }

    if (pageCount === 0) break;
  }

  return wall.slice(0, limit);
}
