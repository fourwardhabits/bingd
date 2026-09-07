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

  // Nothing to say, and four different reasons for it — still loading, failed, an
  // account that has not ranked anything yet, or a run that is currently zero weeks
  // long. All four are the same answer here, and the last one matters: "🔥 0 week
  // streak" is the app telling somebody they are failing at something.
  if (!data?.hasHistory || data.weeks === 0) return null;

  const run = data.weeks === 1 ? 'A one week streak' : `A ${data.weeks} week streak`;
  const state = data.rankedThisWeek ? 'This week ✓' : null;

  return (
    <View style={styles.row}>
      {/**
       * One line, and often only half of one (founder, physical Android, 2026-09-07).
       *
       * The row says `🔥 4 week streak`, and appends `· This week ✓` only once the week
       * has actually been earned. It said `Ranked this week ✓`, which spent three words
       * restating the verb the whole feature is about; and when the week was *not* yet
       * earned it appended a nudge — "Rank something in the next 2 days to keep it
       * going." — which is the row turning into a task the moment somebody has not done
       * it. The founder's rule: no status, no dot and no check after the count unless
       * there is a real one to report.
       *
       * That leaves the open week saying nothing, which is correct. An open week is not
       * a lost one and does not need announcing; the streak itself is unchanged, and the
       * grace it runs on still lives in `streak.ts`.
       */}
      <Text
        variant="callout"
        // The flame is decoration beside a number that already says it. Read out, it
        // would be "fire, four week streak".
        accessibilityLabel={state ? `${run}. ${state}` : run}
      >
        {`🔥 ${data.weeks} week streak`}
        {state ? (
          <Text variant="callout" tone="secondary">
            {` · ${state}`}
          </Text>
        ) : null}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  // Under the goal bars, at the section's own gutter. No top section padding: it
  // belongs to the block above it rather than starting a new one.
  row: { paddingHorizontal: theme.layout.gutter, paddingTop: theme.space[2] },
});
