import { StyleSheet, View, useWindowDimensions } from 'react-native';

import { SectionHeader, SkeletonRow, Text } from '@/ui/components';
import { theme } from '@/ui/tokens';

import { AwardBadge } from './AwardBadge';
import { TierDots } from './TierDots';
import { featuredAwards, PROFILE_AWARD_SLOTS } from './featured';
import type { AwardProgress } from './progress';
import { unlockTimes, useAwardUnlocks } from './use-award-unlocks';
import { useAwards } from './use-awards';

export type ProfileAwardsProps = {
  /** Who is looking. The awards are computed from what *this* account may read. */
  viewerId: string;
  /** Whose shelf: the profile being looked at, which may or may not be the viewer. */
  userId: string;
  /** Opens the full twenty. The one interaction this section has. */
  onSeeAll: () => void;
};

/**
 * bingd. Awards, on the profile — five earned awards, above Goals.
 *
 * ---------------------------------------------------------------------------
 * WHY IT IS A SECTION AND NOT THE BUTTON IT REPLACES
 *
 * Awards were reachable from a profile only through a button labelled `bingd. Awards`,
 * beside Share Profile. Everything a person had earned was behind one tap, which meant
 * a profile said nothing about what its owner had done — the shelf existed and nobody
 * was standing in front of it.
 *
 * **Above Goals, and that order is the product decision rather than a layout one.** An
 * award is something earned and finished; a goal is something in progress. Identity
 * before intention: what this person *is* on Bingd, then what they are working on.
 * ---------------------------------------------------------------------------
 *
 * **Five slots, always five.** The composition does not collapse when somebody has
 * earned one award, and it does not grow when they have earned nine. It was three until
 * the founder's physical pass of 2026-09-06, where a mostly-empty row of three read as a
 * placeholder rather than a record. A row that changes
 * width with achievement makes a new account look broken and a full one look like a
 * different design, and the whole point of the section is that it is the same shelf on
 * every profile with a different amount on it.
 *
 * **An empty slot says nothing.** No "Locked", no "Keep watching", no silhouette of an
 * award nobody has: inventing copy for absence is how a shelf becomes a scoreboard of
 * what somebody has not done. It is an empty well, drawn at the badge's own size so the
 * row keeps its shape — brighter on the owner's own profile, where an unfilled slot is
 * a reasonable thing to want to fill, and quieter on somebody else's, where it is not
 * the visitor's business and a row of conspicuous holes makes the profile read as
 * half-built.
 *
 * **Compact, not a card apiece.** A badge, the tier dots it already wears in the sheet,
 * and the award's own name on two lines at most. The count, the progress fraction and
 * the requirement all stay in the sheet: this row answers "what have they won", and
 * `10 / 14` is an answer to a different question.
 *
 * **See all opens the sheet that already exists.** There is one awards catalogue and
 * this is not it.
 */
export function ProfileAwards({ viewerId, userId, onSeeAll }: ProfileAwardsProps) {
  const isSelf = viewerId === userId;
  const { width } = useWindowDimensions();
  /**
   * The badge, sized so five fit one row without horizontal scrolling.
   *
   * Derived rather than fixed, because five slots at the token's own 52pt overflow a
   * 320pt screen by a few points — and the failure mode of overflowing is the fifth
   * award silently leaving the row, which is the shelf being wrong about what somebody
   * has earned. Capped at the token so a large phone does not inflate them past the
   * size the badge art was cut for.
   */
  const badgeSize = Math.min(
    theme.layout.awardBadge,
    Math.floor(
      (width - theme.layout.gutter * 2 - theme.space[2] * (PROFILE_AWARD_SLOTS - 1)) /
        PROFILE_AWARD_SLOTS,
    ),
  );
  const awards = useAwards(viewerId, userId);
  // Owner only — see `useAwardUnlocks`. A visitor gets no unlock times and the
  // selection falls back to seniority plus the canonical order, which is total.
  const unlocks = useAwardUnlocks(userId, { enabled: isSelf });

  const featured = featuredAwards(awards.data?.awards ?? [], unlockTimes(unlocks.data));

  /**
   * **Nothing at all while the read is in flight or after it failed.**
   *
   * Not an error state, and that is deliberate. This section is a shelf; a profile
   * whose awards could not be read is not broken, it is a profile without a shelf on it
   * this time. An apology block above Goals would give a failed secondary read more of
   * the page than the feature has when it works — and the sheet behind See all has its
   * own error state with its own retry, which is where somebody who wants the answer is
   * going anyway. The same rule the Watchlist shelf on this page already follows.
   */
  if (awards.isError) return null;

  return (
    <View style={styles.section}>
      <SectionHeader
        title="bingd. AWARDS"
        exactCase
        // Offered even with an empty shelf: the sheet is where the twenty are, and
        // "what could I earn" is the question a new account has.
        actionLabel="See all"
        onPressAction={onSeeAll}
      />
      {awards.isPending ? (
        <SkeletonRow count={1} />
      ) : (
        <View style={styles.row}>
          {Array.from({ length: PROFILE_AWARD_SLOTS }, (_, index) => {
            const award = featured[index];
            return award ? (
              <Slot key={award.trackKey} award={award} size={badgeSize} />
            ) : (
              <EmptySlot key={`empty-${index}`} dim={!isSelf} size={badgeSize} />
            );
          })}
        </View>
      )}
    </View>
  );
}

/** One earned award: badge, its tier dots, and what it is called. */
function Slot({ award, size }: { award: AwardProgress; size: number }) {
  return (
    <View
      testID="award-slot"
      style={styles.slot}
      accessible
      accessibilityRole="image"
      // The row's own words, in the order it reads. `title` is the tier's name on a
      // creative track and the family name on a metal one, so `badgeTierLabel` is what
      // carries "Gold" in the cases where the title does not.
      accessibilityLabel={`${award.title}. ${award.badgeTierLabel} earned.`}
    >
      <View style={[styles.badge, { width: size, height: size }]}>
        <AwardBadge badge={award.badge} earned size={size} />
        <TierDots earnedTierIndex={award.earnedTierIndex} />
      </View>
      <Text variant="caption" numberOfLines={2} style={styles.name}>
        {award.title}
      </Text>
    </View>
  );
}

/**
 * A slot nobody has filled.
 *
 * Hidden from the accessibility tree entirely. There is no fact here to announce —
 * "empty award slot" is the interface describing itself — and three of them read out
 * before Goals would be the worst version of this section for the readers least able to
 * skip it.
 */
function EmptySlot({ dim, size }: { dim: boolean; size: number }) {
  return (
    <View
      // The five-slot composition is the thing to hold: a row that changed width with
      // achievement would make a new account look broken. There is nothing else on an
      // empty slot to assert against, so it is named.
      testID="award-slot-empty"
      style={styles.slot}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      <View
        style={[
          styles.badge,
          styles.empty,
          { width: size, height: size, borderRadius: size / 2 },
          dim && styles.emptyDim,
        ]}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  section: { paddingTop: theme.space[5], gap: theme.space[2] },
  /**
   * Five equal columns rather than five content-sized ones, so a one-word award and a
   * three-word award occupy the same slot and the shelf does not shift as it fills.
   *
   * `space[2]` between them rather than `space[3]`: at five across, four points per gap
   * is four points of badge, and the badge is the thing worth the width.
   */
  row: {
    flexDirection: 'row',
    paddingHorizontal: theme.layout.gutter,
    gap: theme.space[2],
  },
  slot: { flex: 1, alignItems: 'center', gap: theme.space[1] },
  // Sized by the caller, so `TierDots` positions against the badge's own bottom edge
  // whatever width five columns leave it.
  badge: {},
  /**
   * A ring, not a pale disc. At this size a low-opacity fill reads as artwork that
   * failed to load; an outline reads as a place something goes.
   */
  empty: {
    borderWidth: StyleSheet.hairlineWidth * 2,
    borderColor: theme.border.hairline,
    backgroundColor: theme.surface.sunken,
  },
  // Somebody else's unfilled slot. Present, so the row keeps its five-slot shape, and
  // quiet, so their profile does not read as a list of things they have not done.
  emptyDim: { opacity: 0.4 },
  name: { textAlign: 'center' },
});
