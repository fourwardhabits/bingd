import type { AwardProgress } from './progress';

/**
 * How many awards a profile puts on the shelf.
 *
 * **Three, and it was nearly five.** The section is an identity artefact sitting above
 * Goals, not a leaderboard: three fit one row at 320pt with the badge large enough to
 * read, and a row of five turns each badge into a thumbnail of something the reader
 * cannot make out. The full twenty are one tap away behind See all, which is where a
 * list belongs.
 */
export const PROFILE_AWARD_SLOTS = 3;

/**
 * When each tier was crossed, keyed `awardKey:tierKey`. See `use-award-unlocks.ts`.
 *
 * Undefined on somebody else's profile, and that is a policy rather than an oversight:
 * `award_unlocks` is owner-read-only, so a visitor's copy would be empty and an empty
 * map is indistinguishable from "nothing earned". The caller passes nothing rather than
 * passing an empty map, and the ordering falls back accordingly.
 */
export type UnlockTimes = ReadonlyMap<string, string>;

/** The ledger key for one tier of one award. */
export const unlockKey = (awardKey: string, tierKey: string) => `${awardKey}:${tierKey}`;

/**
 * The three awards a profile shows, chosen rather than pinned.
 *
 * ---------------------------------------------------------------------------
 * THE ORDER, AND WHY IT IS THESE THREE RULES IN THIS SEQUENCE
 *
 *   1. **Seniority first.** A gold beats a silver beats a bronze, read off
 *      `earnedTierIndex` — the structured tier index the model already carries. Never
 *      off the displayed name: "Wheeze" outranks "Giggle" and nothing in either string
 *      says so, and the metal tracks share three labels between twenty awards.
 *
 *   2. **Then most recently earned**, where that is knowable. It is knowable only on
 *      the owner's own profile, because `award_unlocks` is owner-read-only. This is
 *      what makes the shelf move when somebody earns something: a new gold displaces
 *      the oldest gold, which is the whole reason the section is worth having.
 *
 *   3. **Then the canonical order** — the fixed `PINNED` + `GROUPED` sequence the
 *      awards sheet is in. This is the tiebreak that makes the selection *total*: two
 *      awards at the same tier with no readable unlock time still resolve, the same way
 *      every time, so a visitor's view of a profile does not reshuffle between opens.
 *      Taken from the input's own index, because `awardsFor` already returns that order
 *      and duplicating the table here would be a second copy to keep in step.
 *
 * **Only earned awards are eligible.** A locked track is progress, not an achievement,
 * and a shelf of things somebody has not done is the participation-trophy problem the
 * thresholds were raised to avoid. A track whose number could not be read is excluded
 * for a different reason: `unavailable` means the app does not know, and a shelf is the
 * wrong place to guess. Both simply leave the slot empty.
 * ---------------------------------------------------------------------------
 */
export function featuredAwards(
  awards: readonly AwardProgress[],
  earnedAt?: UnlockTimes,
  slots: number = PROFILE_AWARD_SLOTS,
): AwardProgress[] {
  const canonical = new Map(awards.map((award, index) => [award.trackKey, index]));

  const when = (award: AwardProgress): string | null => {
    if (!earnedAt || !award.earnedTier) return null;
    return earnedAt.get(unlockKey(award.trackKey, award.earnedTier.key)) ?? null;
  };

  return awards
    .filter((award) => award.earnedTier != null && !award.unavailable)
    .sort((a, b) => {
      if (a.earnedTierIndex !== b.earnedTierIndex) return b.earnedTierIndex - a.earnedTierIndex;

      const at = when(a);
      const bt = when(b);
      // Both known, and different: newer first. One known and the other not is *not* a
      // reason to promote the known one — that would let a partially-written ledger
      // reorder a shelf on a fact it does not have. Fall through to canonical instead.
      if (at && bt && at !== bt) return at < bt ? 1 : -1;

      return (canonical.get(a.trackKey) ?? Infinity) - (canonical.get(b.trackKey) ?? Infinity);
    })
    .slice(0, slots);
}
