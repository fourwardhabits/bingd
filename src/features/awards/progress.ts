import { badgeFor, type Badge } from './badges';
import {
  AWARD_TRACKS,
  breakdownTotal,
  count,
  type AwardFacts,
  type AwardTier,
  type AwardTrack,
  type Breakdown,
} from './tracks';

/** One track, evaluated against one reader. Everything a row draws is here. */
export type AwardProgress = {
  trackKey: string;
  /** The family name — "Genre Gremlin". What the row is called before anything. */
  displayName: string;
  /**
   * What the row is **titled**, which is the reward this pass moved.
   *
   * Before the first tier it is the family name. After each tier it becomes the name of
   * the tier reached — Dabbler, then Mixer, then Chaos Collector — because that name is
   * the thing that was won, and a separate "Dabbler earned" line under a heading that
   * still said "Genre Gremlin" was saying it twice and celebrating it once.
   *
   * **Metal tracks keep the family name.** A row headed "Silver" says nothing about
   * what was done, and three of them on one screen say less. The badge art and the tier
   * dots carry the metal.
   */
  title: string;
  /** The badge to draw: the highest tier earned, or the next one, greyed. */
  badge: Badge;
  /** Which tier that badge belongs to, for the accessibility label. */
  badgeTierLabel: string;
  /** Null before the first tier. */
  earnedTier: AwardTier | null;
  /** 0, 1, 2 — or -1 before anything is earned. Also how many dots are filled. */
  earnedTierIndex: number;
  /** Null once the third tier is earned, which is what finished means here. */
  nextTier: AwardTier | null;
  /** Where the reader is, measured against the tier they are working toward. */
  value: number;
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
   * True when the number is a dash because the viewer may not read it, rather than
   * because a read failed. Drawn like `unavailable` — no fraction, no drill-down —
   * but worded as a boundary instead of an apology, and it never sorts into the
   * could-not-load band's "try again" framing by accident: the copy is the difference.
   */
  withheld: boolean;
  /** How far into the next tier, 0 to 1. One once every tier is earned. */
  fraction: number;
};

/**
 * The number, and the rows it is made of, for one tier.
 *
 * The metric *is* the weight of the breakdown — there is no second count to keep in
 * step. Two-Screen Life is why this takes a tier: its caps move with the threshold, so
 * its number genuinely differs between Bronze and Gold. The other nineteen ignore it.
 */
const measure = (track: AwardTrack, facts: AwardFacts, tier: AwardTier) =>
  breakdownTotal(track.contributions(facts, tier));

export function evaluate(track: AwardTrack, facts: AwardFacts): AwardProgress {
  // A read that failed is not a count of zero — and neither is a read the viewer is
  // not entitled to. Both answered before the metric runs, so a track whose field is
  // missing never produces a number nobody measured. The two dashes differ only in
  // what the row says: a failure apologises and can be retried; a boundary is stated
  // once ("Only they can see this one") and a retry would be asking the same policy
  // the same question.
  const withheld = facts.withheld?.has(track.needs) ?? false;
  if (withheld || facts.unavailable?.has(track.needs)) {
    const first = track.tiers[0];
    return {
      trackKey: track.key,
      displayName: track.displayName,
      title: track.displayName,
      badge: badgeFor(track.key, first.key),
      badgeTierLabel: first.label,
      earnedTier: null,
      earnedTierIndex: -1,
      nextTier: first,
      value: 0,
      detailLine: withheld ? 'Only they can see this one' : 'Could not load this one',
      countLabel: '—',
      unavailable: true,
      withheld,
      fraction: 0,
    };
  }

  // Ascending, so the last tier that passes wins. **At the threshold counts as
  // earned** — `>=`, not `>` — which is the boundary every tier test pins down.
  let earnedTierIndex = -1;
  for (const [index, tier] of track.tiers.entries()) {
    if (measure(track, facts, tier) >= tier.threshold) earnedTierIndex = index;
  }
  const earnedTier: AwardTier | null =
    earnedTierIndex >= 0 ? (track.tiers[earnedTierIndex] ?? null) : null;
  const nextTier =
    track.tiers.find((tier) => measure(track, facts, tier) < tier.threshold) ?? null;

  // **One badge per track, never three.** The one on screen is the highest tier
  // actually earned, or — before any of them — the first one, drawn grey. A row
  // showing all three tiers would be a scoreboard of what the reader has not done.
  const badgeTier = earnedTier ?? track.tiers[0];
  const top = track.tiers[2];

  // Measured against the tier being worked toward, which is the only tier the number on
  // the row is about. Past the top there is nothing left to work toward, so it is the
  // top tier's own reading that keeps climbing.
  const value = measure(track, facts, nextTier ?? top);

  return {
    trackKey: track.key,
    displayName: track.displayName,
    /**
     * **Never the next tier's name.** A locked Genre Gremlin says "Genre Gremlin" and
     * "Next: watch 8 different genres" — not "Dabbler", which would hand over the
     * reward before it was earned and leave nothing to arrive later.
     */
    title: earnedTier && !track.metalTiers ? earnedTier.label : track.displayName,
    badge: badgeFor(track.key, badgeTier.key),
    badgeTierLabel: badgeTier.label,
    earnedTier,
    earnedTierIndex,
    nextTier,
    value,
    detailLine: nextTier
      ? `Next: ${track.next(nextTier.threshold)}`
      : // Past the top there is nothing to aim at, so the line states what was done
        // rather than inventing a fourth tier to be short of.
        track.earned(top.threshold),
    countLabel: nextTier ? `${count(value)} / ${count(nextTier.threshold)}` : count(value),
    unavailable: false,
    withheld: false,
    fraction: nextTier ? Math.min(1, value / nextTier.threshold) : 1,
  };
}

/**
 * The rows behind one award's number, for the tier it is working toward.
 *
 * The same call `evaluate` measures with, so the sheet and the badge cannot disagree —
 * and the reason there is no separate drill-down query anywhere in this feature.
 */
export function breakdownFor(
  track: AwardTrack,
  facts: AwardFacts,
  progress: AwardProgress,
): Breakdown {
  return track.contributions(facts, progress.nextTier ?? track.tiers[2]);
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
 * The order the sheet is in, and since 2026-08-30 it is **one order, always**.
 *
 * Top to bottom: the pinned three in {@link PINNED} order, then the other seventeen in
 * {@link GROUPED} order. That is the whole rule. Position is a property of the track and
 * of nothing else — not of what has been earned, not of how close a tier is, not of what
 * was unlocked most recently, and not of whether a number could be read this time.
 *
 * **What this replaced, and why the founder replaced it.** Earned rows used to be
 * promoted above locked ones within their area, and an unreadable row sank to the
 * bottom. Both are defensible in isolation and both mean the same thing in the hand: the
 * sheet a reader closes is not the sheet they reopen. Crossing a tier moved the row that
 * crossed it *and* every row it passed, so the reward for an unlock was a list the
 * reader had to re-learn — and a transient read failure did the same thing for no reason
 * at all. A fixed order is what lets somebody find Space Brain where Space Brain was;
 * the earned state is already said, loudly, by the badge and the tier name on the row
 * itself, which is where a state belongs.
 *
 * No separator and no category heading — the founder ruled on that for this tranche too.
 * `GROUPED` is written in its three runs (activity, genres, exploration) and reads as
 * grouped without a rule being drawn across the sheet to say so.
 *
 * **The comparator is total and stateless**, so two renders of the same twenty tracks
 * produce the same list, and the own-profile sheet and a permitted other-profile sheet
 * are ordered identically — they call this with the same twenty keys.
 */
export function sortAwards(list: AwardProgress[]): AwardProgress[] {
  const orderOf = new Map<string, number>(
    [...PINNED, ...GROUPED].map((key, index) => [key, index]),
  );

  // A track missing from the table sorts after everything it could be compared with,
  // rather than colliding with position zero and making the order depend on the input.
  const last = PINNED.length + GROUPED.length;
  const within = (award: AwardProgress) => orderOf.get(award.trackKey) ?? last;

  return [...list].sort((a, b) => within(a) - within(b));
}

/** Every track, evaluated and ordered. The one entry point a screen needs. */
export function awardsFor(facts: AwardFacts): AwardProgress[] {
  return sortAwards(AWARD_TRACKS.map((track) => evaluate(track, facts)));
}

/** How many tracks could not be read. Zero on any ordinary open. */
export const unavailableCount = (list: AwardProgress[]): number =>
  list.filter((award) => award.unavailable).length;
