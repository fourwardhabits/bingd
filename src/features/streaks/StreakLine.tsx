import { useEffect, useRef } from 'react';
import { StyleSheet, View } from 'react-native';

import { track } from '@/lib/analytics';
import { Text } from '@/ui/components';
import { theme } from '@/ui/tokens';

import { daysLeftInWeek } from './streak';
import { useStreak } from './use-streak';

export type StreakLineProps = {
  /** The owner's own id. This section is not drawn on anybody else's profile. */
  userId: string;
};

/**
 * The weekly ranking streak, on the owner's own profile.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS DELIBERATELY NOT HERE
 *
 * No coins, no points, no XP, no daily streak, no loss animation, no streak freeze and
 * nothing to buy. The founder ruled every one of those out by name, and the reason they
 * are worth naming in the code is that each is a small, plausible-looking addition on
 * its own — the mechanic only becomes punitive by accumulating them.
 *
 * There is no streak landing page either. A row of two lines under the awards shelf is
 * the whole surface, because what v1 has to learn is whether a streak changes when
 * somebody comes back, and a page nobody visits answers nothing.
 * ---------------------------------------------------------------------------
 *
 * **It says nothing at all until there is something to say.** A reader who has never
 * ranked anything gets no section: "🔥 0 weeks" on a new account is the app telling
 * somebody they are failing at something they have not started. It also stays away when
 * the read fails — the same rule the awards shelf and the watchlist shelf on this page
 * already follow, and for the same reason: a failed secondary read must not take more of
 * the profile than the feature does when it works.
 *
 * **An open week is not a lost one.** With a live streak and no ranking yet this week,
 * the second line says how long there is to keep it — days, not a countdown, and once,
 * not four times. `streak.ts` is where the grace itself lives.
 */
export function StreakLine({ userId }: StreakLineProps) {
  const streak = useStreak(userId);
  const reported = useRef(false);

  const data = streak.data;
  const daysLeft = daysLeftInWeek(new Date());

  useEffect(() => {
    /**
     * Once per settled read, not once per render.
     *
     * The profile is a tab and stays mounted, so a bare effect on `data` would emit
     * again every time React re-ran it — counting scrolling as viewing. The ref is
     * component-lifetime, which is the honest granularity for "this reader saw their
     * streak this session".
     */
    if (!data?.hasHistory || reported.current) return;
    reported.current = true;
    track({
      name: 'streak_state_viewed',
      props: {
        weeks: data.weeks,
        ranked_this_week: data.rankedThisWeek,
        days_left: daysLeft,
      },
    });
  }, [data, daysLeft]);

  // Nothing to say, and three different reasons for it — still loading, failed, or an
  // account that has not ranked anything yet. All three are the same answer here.
  if (!data?.hasHistory) return null;

  const run = data.weeks === 1 ? 'A one week streak' : `A ${data.weeks} week streak`;
  const state = line(data.weeks, data.rankedThisWeek, daysLeft);

  return (
    <View style={styles.row}>
      {/* One line, not two. The flame and the number are the fact; what follows the
          middle dot is its state. A separator rather than a second line, because this
          row sits under the goal bars and a two-line block there would rebuild the
          section the founder just collapsed. */}
      <Text
        variant="callout"
        // The flame is decoration beside a number that already says it. Read out, it
        // would be "fire, four weeks".
        accessibilityLabel={`${run}. ${state}`}
      >
        {`🔥 ${data.weeks} ${data.weeks === 1 ? 'week' : 'weeks'}`}
        <Text variant="callout" tone="secondary">
          {` · ${state}`}
        </Text>
      </Text>
    </View>
  );
}

/**
 * The second line, and there are exactly three of them.
 *
 * Safe, at risk, and broken — said plainly and without a countdown. "Rank something in
 * the next 2 days" is a fact; "2 days left!" is pressure, and the difference is the
 * whole of what keeps this from being the mechanic the founder ruled out.
 */
function line(weeks: number, rankedThisWeek: boolean, daysLeft: number): string {
  if (rankedThisWeek) return 'Ranked this week ✓';
  if (weeks === 0) return 'Rank something this week to start a new one.';
  return daysLeft === 1
    ? 'Rank something today to keep it going.'
    : `Rank something in the next ${daysLeft} days to keep it going.`;
}

const styles = StyleSheet.create({
  // Under the goal bars, at the section's own gutter. No top section padding: it
  // belongs to the block above it rather than starting a new one.
  row: { paddingHorizontal: theme.layout.gutter, paddingTop: theme.space[2] },
});
