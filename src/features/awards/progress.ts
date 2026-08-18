import { badgeFor, type Badge } from './badges';
import {
  AWARD_TRACKS,
  count,
  type AwardFacts,
  type AwardTier,
  type AwardTrack,
} from './tracks';

/** One track, evaluated against one reader. Everything a row draws is here. */
export type AwardProgress = {
  trackKey: string;
  displayName: string;
  /** The badge to draw: the highest tier earned, or the next one, greyed. */
  badge: Badge;
  /** Which tier that badge belongs to, for the accessibility label. */
  badgeTierLabel: string;
  /** Null before the first tier. */
  earnedTier: AwardTier | null;
  /** 0, 1, 2 — or -1 before anything is earned. */
  earnedTierIndex: number;
  /** Null once the third tier is earned, which is what finished means here. */
  nextTier: AwardTier | null;
  /** Where the reader is, measured against the tier they are working toward. */
  value: number;
  /** `Bronze earned`, or nothing yet. Present at the top tier too. */
  earnedLine: string | null;
  /** `Next: Watch 50 movies` — or, at the top, what was done to finish it. */
  detailLine: string;
  /** `27 / 50` while there is a tier to reach, and `1,164` once there is not. */
  countLabel: string;
  /**
   * True when the number behind this track could not be read at all.
   *
   * Not the same as zero, and drawn differently: a locked badge and "Could not load
   * this one" rather than a progress fraction the app does not actually know.
   */
  unavailable: boolean;
  /**
   * Whether tapping the row opens the titles behind the number.
   *
   * False on the seven tracks whose number is not made of titles, and false on any
   * track whose number could not be read — a drill-down into a count that failed would
   * be a list claiming to explain a dash.
   */
  hasContributors: boolean;
  /** How far into the next tier, 0 to 1. One once every tier is earned. */
  fraction: number;
};

export function evaluate(track: AwardTrack, facts: AwardFacts): AwardProgress {
  // A read that failed is not a count of zero. Answered before the metric runs, so a
  // track whose field is missing never produces a number nobody measured.
  if (facts.unavailable?.has(track.needs)) {
    const first = track.tiers[0];
    return {
      trackKey: track.key,
      displayName: track.displayName,
      badge: badgeFor(track.key, first.key),
      badgeTierLabel: first.label,
      earnedTier: null,
      earnedTierIndex: -1,
      nextTier: first,
      value: 0,
      earnedLine: null,
      detailLine: 'Could not load this one',
      countLabel: '—',
      unavailable: true,
      hasContributors: false,
      fraction: 0,
    };
  }

  /**
   * The number, for one tier.
   *
   * Almost every track ignores the tier and is measured once — `base` below — because
   * a metric over a thousand watched titles is not free and running it three times to
   * get the same answer would be. Two-Screen Life is the exception the whole shape
   * exists for: its caps move with the tier, so its number genuinely differs between
   * Bronze and Gold.
   */
  const base = track.metricAt ? null : track.metric(facts);
  const measure = (tier: AwardTier) =>
    track.metricAt ? track.metricAt(facts, tier) : (base as number);

  // Ascending, so the last tier that passes wins. **At the threshold counts as
  // earned** — `>=`, not `>` — which is the boundary every tier test pins down.
  let earnedTierIndex = -1;
  for (const [index, tier] of track.tiers.entries()) {
    if (measure(tier) >= tier.threshold) earnedTierIndex = index;
  }
  const earnedTier: AwardTier | null =
    earnedTierIndex >= 0 ? (track.tiers[earnedTierIndex] ?? null) : null;
  const nextTier = track.tiers.find((tier) => measure(tier) < tier.threshold) ?? null;

  // **One badge per track, never three.** The one on screen is the highest tier
  // actually earned, or — before any of them — the first one, drawn grey. A row
  // showing all three tiers would be a scoreboard of what the reader has not done.
  const badgeTier = earnedTier ?? track.tiers[0];
  const top = track.tiers[2];

  // Measured against the tier being worked toward, which is the only tier the number
  // on the row is about. Past the top there is nothing left to work toward, so it is
  // the top tier's own reading that keeps climbing.
  const value = measure(nextTier ?? top);

  return {
    trackKey: track.key,
    displayName: track.displayName,
    badge: badgeFor(track.key, badgeTier.key),
    badgeTierLabel: badgeTier.label,
    earnedTier,
    earnedTierIndex,
    nextTier,
    value,
    // Two short lines rather than one long one, at every stage of a track's life. At
    // the top the pair reads "Gold earned" over "Watched 1,000 movies", which is the
    // founder's shape: the tier on its own line, and the thing that earned it under it.
    earnedLine: earnedTier ? `${earnedTier.label} earned` : null,
    detailLine: nextTier
      ? `Next: ${track.next(nextTier.threshold)}`
      : // Past the top there is nothing to aim at, so the line states what was done
        // rather than inventing a fourth tier to be short of.
        track.earned(top.threshold),
    countLabel: nextTier ? `${count(value)} / ${count(nextTier.threshold)}` : count(value),
    unavailable: false,
    hasContributors: Boolean(track.contributors),
    fraction: nextTier ? Math.min(1, value / nextTier.threshold) : 1,
  };
}

/**
 * The three that are pinned, in the order they are pinned in.
 *
 * **They never move.** Not when they are earned, not when they are not, not when a
 * dozen genre tracks are closer to unlocking. They are the three things Bingd is for —
 * watch films, watch television, bring somebody with you — and a list whose top is
 * decided by whichever badge the reader happens to be nearest is a list that stops
 * saying what the product is about.
 */
export const PINNED = ['movie-muncher', 'season-snacker', 'invite-instigator'] as const;

/**
 * The rest, grouped, in the order a group is read in.
 *
 * **This is the tiebreak, and it is a list rather than a formula.** Sorting the
 * remaining seventeen by percentage-to-next-tier alone produced a sheet that reordered
 * itself every time somebody logged a film — a genre track jumping over Heart Magnet
 * because it went from 24% to 26% is movement without meaning, and it destroys the one
 * thing a long list needs, which is that the reader can find the row they saw last time
 * roughly where they left it.
 *
 * So order within a bucket is fixed: what kind of thing the award is about, and then a
 * deliberate order inside that. What *does* move is which bucket a track is in, and
 * that changes exactly once per tier — when it is earned.
 */
const GROUPED: readonly string[] = [
  // Activity — things the reader does.
  'rating-rascal',
  'comment-gremlin',
  'hype-courier',
  'heart-magnet',
  'mutual-mania',
  'queue-dragon',
  // Genres — what they watch.
  'scream-snack',
  'lol-mode',
  'softie-hours',
  'space-brain',
  'boom-club',
  'toon-bloom',
  'truth-worm',
  // Exploration — how widely.
  'passport-mode',
  'time-hopper',
  'genre-gremlin',
  'two-screen-life',
];

/**
 * The order the sheet is in, and it is most of the reward.
 *
 * Top to bottom:
 *
 *   1. The pinned three, always, in {@link PINNED} order.
 *   2. Everything else earned, in {@link GROUPED} order.
 *   3. Everything else locked, in {@link GROUPED} order.
 *   4. Anything whose number could not be read.
 *
 * **Earned rises, but only within its own area.** An earned genre track sits above the
 * locked genre tracks and below the earned activity ones, which is what "can rise"
 * means here — it is promoted past the locked rows without being teleported to the top
 * of a list it has nothing to do with.
 *
 * **The comparator is total and depends on nothing but the track's own state**, so two
 * renders of the same data cannot disagree and no amount of scrolling reshuffles
 * anything. There is no name comparison left in it, because there is no tie left to
 * break: `GROUPED` has one position per track.
 *
 * A pinned track that could not be read stays pinned. It is the one exception to the
 * apology-sinks rule below, and it is the right one: the top of this sheet is a
 * statement about the product, not a leaderboard, and a gap at position three would be
 * more confusing than a row saying it could not load.
 */
export function sortAwards(list: AwardProgress[]): AwardProgress[] {
  const pinnedAt = new Map<string, number>(PINNED.map((key, index) => [key, index]));
  const groupedAt = new Map<string, number>(GROUPED.map((key, index) => [key, index]));

  /** 0 pinned, 1 earned, 2 locked, 3 unreadable. */
  const band = (award: AwardProgress) => {
    if (pinnedAt.has(award.trackKey)) return 0;
    // Last, and below even a track at zero: a row that says "could not load this one"
    // is the app apologising, and an apology belongs at the bottom of a list somebody
    // opened to enjoy themselves.
    if (award.unavailable) return 3;
    return award.earnedTier ? 1 : 2;
  };

  // A track missing from both tables sorts after everything it could be compared with,
  // rather than colliding with position zero and making the order depend on the input.
  const within = (award: AwardProgress) =>
    pinnedAt.get(award.trackKey) ?? groupedAt.get(award.trackKey) ?? GROUPED.length;

  return [...list].sort((a, b) => band(a) - band(b) || within(a) - within(b));
}

/** Every track, evaluated and ordered. The one entry point a screen needs. */
export function awardsFor(facts: AwardFacts): AwardProgress[] {
  return sortAwards(AWARD_TRACKS.map((track) => evaluate(track, facts)));
}

/** How many tracks could not be read. Zero on any ordinary open. */
export const unavailableCount = (list: AwardProgress[]): number =>
  list.filter((award) => award.unavailable).length;
