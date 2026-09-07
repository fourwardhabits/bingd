import { featuredAwards, PROFILE_AWARD_SLOTS, unlockKey } from './featured';
import type { AwardProgress } from './progress';

/**
 * Which three awards a profile puts on its shelf.
 *
 * The rules, in the order they apply: seniority, then recency where it is knowable, then
 * the canonical order the sheet is already in. The third is not a formality — it is what
 * makes the selection *total*, so that a visitor opening the same profile twice sees the
 * same three badges in the same places.
 */

/** A track evaluated to a given tier. Only the fields the selection reads are real. */
const at = (
  trackKey: string,
  earnedTierIndex: number,
  over: Partial<AwardProgress> = {},
): AwardProgress =>
  ({
    trackKey,
    displayName: trackKey,
    title: trackKey,
    earnedTierIndex,
    earnedTier:
      earnedTierIndex >= 0
        ? { key: ['bronze', 'silver', 'gold'][earnedTierIndex], label: 'T', threshold: 1 }
        : null,
    nextTier: null,
    value: 1,
    detailLine: '',
    countLabel: '',
    unavailable: false,
    withheld: false,
    fraction: 1,
    badgeTierLabel: 'T',
    badge: { kind: 'emoji', emoji: '🏆' },
    ...over,
  }) as AwardProgress;

const keys = (list: AwardProgress[]) => list.map((award) => award.trackKey);

describe('how many', () => {
  it('is five', () => {
    // Three until the founder's physical pass of 2026-09-06: a mostly-empty row of
    // three read as a placeholder rather than as a record of what somebody had earned.
    expect(PROFILE_AWARD_SLOTS).toBe(5);
  });

  it('never returns more than the slots, however many were earned', () => {
    const many = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((key) => at(key, 0));
    expect(featuredAwards(many)).toHaveLength(5);
  });

  it('returns fewer than the slots rather than padding, and the section draws the gap', () => {
    // The three-slot composition is the section's job, not this function's. Inventing a
    // placeholder here would put a thing that is not an award into a list of awards.
    expect(featuredAwards([at('a', 0)])).toHaveLength(1);
    expect(featuredAwards([])).toEqual([]);
  });
});

describe('what is eligible', () => {
  it('excludes anything with no tier earned', () => {
    // A locked track is progress, not an achievement. A shelf of things somebody has not
    // done is the participation-trophy problem the thresholds were raised to avoid.
    expect(keys(featuredAwards([at('locked', -1), at('bronze', 0)]))).toEqual(['bronze']);
  });

  it('excludes a track whose number could not be read', () => {
    // `unavailable` means the app does not know, and a shelf is the wrong place to guess.
    // Note it arrives with `earnedTierIndex: -1` from `evaluate` anyway; this asserts the
    // guard directly so a future shape change cannot quietly promote an unknown.
    const broken = at('broken', 2, { unavailable: true });
    expect(keys(featuredAwards([broken, at('bronze', 0)]))).toEqual(['bronze']);
  });

  it('excludes a withheld track, which is a boundary rather than a failure', () => {
    const hidden = at('hidden', 2, { unavailable: true, withheld: true });
    expect(keys(featuredAwards([hidden, at('bronze', 0)]))).toEqual(['bronze']);
  });
});

describe('seniority first', () => {
  it('puts gold above silver above bronze', () => {
    const list = [at('bronze', 0), at('gold', 2), at('silver', 1)];
    expect(keys(featuredAwards(list))).toEqual(['gold', 'silver', 'bronze']);
  });

  it('reads the tier index, never the displayed name', () => {
    // "Wheeze" outranks "Giggle" and nothing in either string says so; the metal tracks
    // share three labels between twenty awards. The structured index is the only thing
    // that can answer this.
    const list = [at('giggle', 2, { title: 'Giggle' }), at('wheeze', 0, { title: 'Wheeze' })];
    expect(keys(featuredAwards(list))).toEqual(['giggle', 'wheeze']);
  });
});

describe('then most recently earned', () => {
  const times = new Map([
    [unlockKey('older', 'bronze'), '2026-01-01T00:00:00Z'],
    [unlockKey('newer', 'bronze'), '2026-06-01T00:00:00Z'],
  ]);

  it('puts the newer of two equal tiers first', () => {
    const list = [at('older', 0), at('newer', 0)];
    expect(keys(featuredAwards(list, times))).toEqual(['newer', 'older']);
  });

  it('does not let recency beat seniority', () => {
    // A brand new bronze does not displace an old gold. The shelf is what somebody has
    // achieved, and "most recent" is only ever the tiebreak inside one tier.
    const list = [at('gold', 2), at('newer', 0)];
    expect(keys(featuredAwards(list, times))).toEqual(['gold', 'newer']);
  });

  it('falls back to canonical order when one of the pair has no recorded time', () => {
    /**
     * The trap this guards. Promoting the award *with* a timestamp over the one without
     * would let a partially-written ledger reorder the shelf on a fact it does not have
     * — and the ledger is genuinely partial: its rollout backfill wrote `announced =
     * false` rows for progress that predated it, and a tier crossed before 20260828000100
     * has no row at all.
     */
    const list = [at('untimed', 0), at('newer', 0)];
    expect(keys(featuredAwards(list, times))).toEqual(['untimed', 'newer']);
  });

  it('is unavailable on somebody else’s profile, and the order is still total', () => {
    // `award_unlocks` is owner-read-only, so a visitor passes no map at all rather than
    // an empty one — an empty map would be indistinguishable from "nothing earned".
    const list = [at('newer', 0), at('older', 0)];
    expect(keys(featuredAwards(list, undefined))).toEqual(['newer', 'older']);
  });
});

describe('then the canonical order, which is what makes it total', () => {
  it('keeps the input order for awards that tie on everything else', () => {
    // `awardsFor` returns the fixed PINNED + GROUPED sequence, so the input's own index
    // *is* the canonical order — and duplicating that table here would be a second copy
    // to keep in step.
    const list = [at('first', 1), at('second', 1), at('third', 1)];
    expect(keys(featuredAwards(list))).toEqual(['first', 'second', 'third']);
  });

  it('gives the same answer twice, so a profile does not reshuffle between opens', () => {
    const list = [at('a', 1), at('b', 2), at('c', 1), at('d', 0), at('e', 2)];
    expect(keys(featuredAwards(list))).toEqual(keys(featuredAwards(list)));
    expect(keys(featuredAwards(list))).toEqual(['b', 'e', 'a', 'c', 'd']);
  });

  it('does not mutate the list it was given', () => {
    // It sorts, and `Array.prototype.sort` is in place. The caller is holding React
    // Query's cached array.
    const list = [at('bronze', 0), at('gold', 2)];
    featuredAwards(list);
    expect(keys(list)).toEqual(['bronze', 'gold']);
  });
});
