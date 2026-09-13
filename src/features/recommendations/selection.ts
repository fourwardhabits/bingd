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
  /** Never sample from fewer than two walls' worth, nor from more than eight. */
  minPool: 40,
  maxPool: 160,
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
): { pool: Scored[]; rest: Scored[] } {
  const byScore = [...scored].sort(
    (a, b) => b.explanation.total - a.explanation.total || a.mediaItemId.localeCompare(b.mediaItemId),
  );
  if (byScore.length === 0) return { pool: [], rest: [] };

  const frontier = byScore[Math.min(config.frontierRank, byScore.length) - 1]!.explanation.total;
  const qualified = byScore.filter((item) => item.explanation.total >= frontier * config.qualifyRatio).length;
  const size = Math.max(Math.min(config.minPool, byScore.length), Math.min(qualified, config.maxPool));
  return { pool: byScore.slice(0, size), rest: byScore.slice(size) };
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
  const { pool, rest } = qualifiedPool(scored, config);
  if (pool.length === 0) return [];

  const top = pool[0]!.explanation.total;
  const bottom = pool[pool.length - 1]!.explanation.total;
  const tau = Math.max(1e-6, config.temperature * Math.max(top - bottom, 0.02));

  const keyed = pool.map((item) => ({
    item,
    key:
      item.explanation.total / tau -
      exposurePenalty(input.durable?.get(item.mediaItemId), input.session?.get(item.mediaItemId), input.now, config) +
      gumbel(input.seed, item.mediaItemId),
  }));
  const tail = [...rest];

  const limit = Math.max(1, input.pages) * input.pageSize;
  const wall: Scored[] = [];

  while (wall.length < limit && (keyed.length > 0 || tail.length > 0)) {
    const perGenre = new Map<string, number>();
    const perAnchor = new Map<string, number>();
    const perLead = new Map<string, number>();
    const perFranchise = new Map<string, number>();
    const page: Scored[] = [];

    const blocked = (item: Scored) => {
      const franchise = franchiseKey(item.title);
      if (franchise != null && (perFranchise.get(franchise) ?? 0) >= maxPerFranchise()) return true;
      return item.explanation.anchors.some((hit) => (perAnchor.get(hit.mediaItemId) ?? 0) >= maxPerAnchor());
    };
    const take = (item: Scored) => {
      page.push(item);
      const genre = item.genres[0];
      if (genre) perGenre.set(genre, (perGenre.get(genre) ?? 0) + 1);
      const franchise = franchiseKey(item.title);
      if (franchise != null) perFranchise.set(franchise, (perFranchise.get(franchise) ?? 0) + 1);
      for (const hit of item.explanation.anchors) perAnchor.set(hit.mediaItemId, (perAnchor.get(hit.mediaItemId) ?? 0) + 1);
      const lead = item.explanation.anchors[0]?.mediaItemId;
      if (lead) perLead.set(lead, (perLead.get(lead) ?? 0) + 1);
    };

    // The qualified pool first, by penalised key.
    while (page.length < input.pageSize && keyed.length > 0) {
      let best = -1;
      let bestKey = Number.NEGATIVE_INFINITY;
      for (let index = 0; index < keyed.length; index += 1) {
        const { item, key } = keyed[index]!;
        if (blocked(item)) continue;
        const genre = item.genres[0];
        const lead = item.explanation.anchors[0]?.mediaItemId;
        const penalty =
          config.genreRepeatPenalty * Math.max(0, (genre ? (perGenre.get(genre) ?? 0) : 0) - config.genreFreeCount + 1) +
          config.anchorRepeatPenalty * (lead ? (perLead.get(lead) ?? 0) : 0);
        if (key - penalty > bestKey) {
          bestKey = key - penalty;
          best = index;
        }
      }
      if (best < 0) break;
      take(keyed.splice(best, 1)[0]!.item);
    }

    // Then the rest, in score order, only if the pool could not fill this page.
    for (let index = 0; page.length < input.pageSize && index < tail.length; ) {
      const item = tail[index]!;
      if (blocked(item)) {
        index += 1;
        continue;
      }
      take(item);
      tail.splice(index, 1);
    }

    if (page.length === 0) break;
    wall.push(...page);
  }

  return wall.slice(0, limit);
}
