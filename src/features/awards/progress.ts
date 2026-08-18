import { badgeFor, type Badge } from './badges';
import { AWARD_TRACKS, type AwardFacts, type AwardTier, type AwardTrack } from './tracks';

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
  /** 0, 1, 2 — or -1 before anything is earned. What "highest earned" sorts on. */
  earnedTierIndex: number;
  /** Null once the third tier is earned, which is what finished means here. */
  nextTier: AwardTier | null;
  /** Where the reader is. Not clamped: past the top tier it keeps climbing. */
  value: number;
  /** `Bronze earned`, or nothing yet. */
  earnedLine: string | null;
  /** `Next: Watch 50 movies`, or `Gold earned: Watched 150 movies` at the top. */
  detailLine: string;
  /** `27 / 50` while there is a tier to reach, and `164` once there is not. */
  countLabel: string;
  /** The track's own caveat, where it has one. */
  note?: string;
  /** How far into the next tier, 0 to 1. One once every tier is earned. */
  fraction: number;
};

export function evaluate(track: AwardTrack, facts: AwardFacts): AwardProgress {
  const value = track.metric(facts);

  // Ascending, so the last tier that passes wins. **At the threshold counts as
  // earned** — `>=`, not `>` — which is the boundary every tier test pins down.
  let earnedTierIndex = -1;
  for (const [index, tier] of track.tiers.entries()) {
    if (value >= tier.threshold) earnedTierIndex = index;
  }
  const earnedTier: AwardTier | null =
    earnedTierIndex >= 0 ? (track.tiers[earnedTierIndex] ?? null) : null;
  const nextTier = track.tiers.find((tier) => value < tier.threshold) ?? null;

  // **One badge per track, never three.** The one on screen is the highest tier
  // actually earned, or — before any of them — the first one, drawn grey. A row
  // showing all three tiers would be a scoreboard of what the reader has not done.
  const badgeTier = earnedTier ?? track.tiers[0];
  const top = track.tiers[2];

  return {
    trackKey: track.key,
    displayName: track.displayName,
    badge: badgeFor(track.key, badgeTier.key),
    badgeTierLabel: badgeTier.label,
    earnedTier,
    earnedTierIndex,
    nextTier,
    value,
    // Suppressed at the top, where the detail line already says "Gold earned" and two
    // lines saying it is one line too many.
    earnedLine: earnedTier && nextTier ? `${earnedTier.label} earned` : null,
    detailLine: nextTier
      ? `Next: ${track.next(nextTier.threshold)}`
      : // Past the top there is nothing to aim at, so the line states what was done
        // rather than inventing a fourth tier to be short of.
        `${top.label} earned: ${track.earned(top.threshold)}`,
    countLabel: nextTier ? `${value} / ${nextTier.threshold}` : `${value}`,
    note: track.note,
    fraction: nextTier ? Math.min(1, value / nextTier.threshold) : 1,
  };
}

/**
 * The order the sheet is in, and it is most of the reward.
 *
 * Founder's rule, top to bottom: finished tracks, then everything else earned with the
 * highest tier first, then locked tracks closest to their next unlock, then the rest.
 *
 * The last two are one rule with a continuous key rather than two buckets. "Closest to
 * the next unlock" already puts the far-off ones last, and splitting them would need a
 * cut-off nobody could defend. `fraction` is that key, so a reader at 9 of 10 sits above
 * one at 60 of 150 — sixty is the larger number and one of them is nearly there.
 *
 * **Thresholds are not comparable across tracks.** 150 movies and 1 mutual follow are
 * both a top tier, so "highest earned" is the tier's *position*, never its number.
 *
 * Ties break on the display name, so the list cannot reshuffle between two renders of
 * the same data — which an unstable comparator would do on a fresh install, where a
 * dozen tracks all sit at exactly zero.
 */
export function sortAwards(list: AwardProgress[]): AwardProgress[] {
  /** 0 finished, 1 earned and climbing, 2 locked. */
  const band = (award: AwardProgress) => {
    if (!award.earnedTier) return 2;
    return award.nextTier ? 1 : 0;
  };

  return [...list].sort((a, b) => {
    const byBand = band(a) - band(b);
    if (byBand !== 0) return byBand;

    if (a.earnedTierIndex !== b.earnedTierIndex) return b.earnedTierIndex - a.earnedTierIndex;
    if (a.fraction !== b.fraction) return b.fraction - a.fraction;

    return a.displayName.localeCompare(b.displayName, 'en');
  });
}

/** Every track, evaluated and ordered. The one entry point a screen needs. */
export function awardsFor(facts: AwardFacts): AwardProgress[] {
  return sortAwards(AWARD_TRACKS.map((track) => evaluate(track, facts)));
}

/** `6 awards earned`, or nothing at all when none are. */
export function earnedSummary(list: AwardProgress[]): string | null {
  const earned = list.filter((award) => award.earnedTier).length;
  if (earned === 0) return null;
  return earned === 1 ? '1 award earned' : `${earned} awards earned`;
}
