import { useLocalSearchParams, useRouter } from 'expo-router';
import { useMemo, useState } from 'react';
import { ScrollView, StyleSheet, View, useWindowDimensions } from 'react-native';

import { useCurrentProfile } from '@/features/auth';
import { AwardBreakdownSheet } from '@/features/awards/AwardBreakdownSheet';
import { CelebrationBackdrop } from '@/features/awards/CelebrationBackdrop';
import { CelebrationCard } from '@/features/awards/CelebrationCard';
import { StreakCelebrationCard } from '@/features/awards/StreakCelebrationCard';
import { celebrationGrid } from '@/features/awards/celebration-posters';
import { breakdownFor } from '@/features/awards/progress';
import { AWARD_TRACKS } from '@/features/awards/tracks';
import { useAwardUnlocks } from '@/features/awards/use-award-unlocks';
import { useAwards } from '@/features/awards/use-awards';
import { useStreakTitles } from '@/features/streaks/use-streak-titles';
import { Button, Screen, Text } from '@/ui/components';
import { theme } from '@/ui/tokens';

/** One page of the celebration flow. */
type Page =
  { kind: 'award'; awardKey: string; tierKey: string } | { kind: 'streak'; weeks: number };

/**
 * What a ranking earned, celebrated — one award, several, a weekly streak, or all of it.
 *
 * ---------------------------------------------------------------------------
 * THE CONTRACT WITH THE RANKING, WHICH IS THAT THERE ISN'T ONE
 *
 * A ranking is finished before this route exists. The award was granted by a database
 * trigger inside the ranking's own transaction and the streak is derived from
 * `rankings.created_at`; nothing here writes anything, so nothing here can grant an
 * award twice. Every failure — a poster that will not load, a fact read that errors, an
 * award key this bundle has never heard of, this file throwing outright — leaves a
 * ranking that succeeded and a collection that moved.
 *
 * Done is unconditional for the same reason: `router.back()` and nothing else.
 * ---------------------------------------------------------------------------
 *
 * **Reached three ways, all handing it the same thing.** A finished ranking drains the
 * celebration queue into it (`celebration-queue.ts`); an award notification in the inbox
 * pushes here with the key and tier the row already carries; and the same route reopens
 * from history. There is no second source of truth — the URL names what to celebrate.
 *
 * **One flow, however many things happened.** One ranking can cross a Movies threshold,
 * a combined Movies-and-TV threshold *and* start the reader's fourth consecutive week.
 * Three modals stacked on each other is three things to dismiss for one moment, so they
 * page horizontally with one set of controls and a position line.
 */
export default function AwardCelebrationScreen() {
  const router = useRouter();
  const profile = useCurrentProfile();
  const { awards: awardParam, streak: streakParam } = useLocalSearchParams<{
    awards?: string;
    streak?: string;
  }>();
  const { width } = useWindowDimensions();
  const [page, setPage] = useState(0);
  /** Which page's contributing titles are open, if any. */
  const [inspecting, setInspecting] = useState<number | null>(null);

  /**
   * `award:tier,award:tier` and `streak=4` — the smallest thing that names each.
   *
   * Two parameters rather than one blob, because the award half has to stay exactly what
   * the notification deep link already sends; changing its shape would strand every
   * notification already written. Awards lead, because an award is the rarer event and
   * the streak is the week's ordinary confirmation.
   *
   * A malformed or missing pair is dropped rather than guessed at: a celebration with
   * nothing in it is not a state worth rendering, and the screen closes itself.
   */
  const pages = useMemo<Page[]>(() => {
    const awards = (awardParam ?? '')
      .split(',')
      .map((pair) => pair.split(':'))
      .filter(
        (parts): parts is [string, string] =>
          parts.length === 2 && Boolean(parts[0]) && Boolean(parts[1]),
      )
      .map(([awardKey, tierKey]) => ({ kind: 'award' as const, awardKey, tierKey }));

    const weeks = Number(streakParam);
    // Two or more, because a streak of one is a week rather than a streak — the same
    // rule `streakAdvanced` applies before anything reaches this screen.
    const streak: Page[] =
      Number.isFinite(weeks) && weeks >= 2 ? [{ kind: 'streak' as const, weeks }] : [];

    return [...awards, ...streak];
  }, [awardParam, streakParam]);

  /**
   * The facts behind the posters.
   *
   * The same read the Awards sheet uses, so the wall behind an award is built from the
   * titles its own breakdown counts. Unavailable, still loading, or failed all mean the
   * same thing here: no wall. The card is the message and does not need one.
   */
  const facts = useAwards(profile.id, profile.id);
  /**
   * The ledger, for one field: when each tier was crossed. Not identity — the URL
   * carries that — and not permission. It narrows the poster candidates to titles the
   * reader already had when the award was earned, so a wall opened from a notification
   * next month is still the collection as it was.
   */
  const unlocks = useAwardUnlocks(profile.id);
  /** Everything ranked inside the streak's own weeks. Idle unless a streak page exists. */
  const streakWeeks = pages.find(
    (item): item is Extract<Page, { kind: 'streak' }> => item.kind === 'streak',
  )?.weeks;
  const streakTitles = useStreakTitles(profile.id, streakWeeks ?? null);

  const current = pages[Math.min(page, Math.max(0, pages.length - 1))];

  /** The breakdown behind the open page, for See titles. Awards only. */
  const openBreakdown = useMemo(() => {
    if (inspecting == null || !facts.data) return null;
    const item = pages[inspecting];
    if (!item || item.kind !== 'award') return null;
    const track = AWARD_TRACKS.find((candidate) => candidate.key === item.awardKey);
    const progress = facts.data.awards.find((a) => a.trackKey === item.awardKey);
    if (!track || !progress) return null;
    return { award: progress, breakdown: breakdownFor(track, facts.data.facts, progress) };
  }, [inspecting, facts.data, pages]);

  const gridFor = (item: Page) => {
    if (!facts.data) return null;
    if (item.kind === 'streak') {
      /**
       * A streak's wall is everything ranked inside its weeks — all fifteen titles of a
       * four-week run, not one per week. The grid still standardises how many it draws;
       * `See titles` is where the full set lives.
       */
      return celebrationGrid({
        contributing: streakTitles.data ?? [],
        collection: facts.data.facts.watched,
        awardKey: 'weekly-streak',
        tierKey: String(item.weeks),
      });
    }
    const track = AWARD_TRACKS.find((candidate) => candidate.key === item.awardKey);
    const progress = facts.data.awards.find((a) => a.trackKey === item.awardKey);
    /**
     * The award's own contributing titles, where it has any. `breakdownFor` is the same
     * call the metric is measured from, so a poster on this wall is a title that
     * genuinely counted. A track that is not about titles — invites, comments, reactions
     * — returns rows with no poster, and `celebrationGrid` falls through to the
     * collection.
     */
    const contributing =
      track && progress
        ? breakdownFor(track, facts.data.facts, progress).sections.flatMap((s) => s.rows)
        : [];

    return celebrationGrid({
      contributing,
      collection: facts.data.facts.watched,
      awardKey: item.awardKey,
      tierKey: item.tierKey,
      asOf:
        unlocks.data?.find(
          (row) => row.awardKey === item.awardKey && row.tierKey === item.tierKey,
        )?.earnedAt ?? null,
    });
  };

  const grid = current ? gridFor(current) : null;
  const last = page >= pages.length - 1;
  /**
   * Whether See titles has anything behind it.
   *
   * Hidden rather than disabled-and-lying for a track with no title contributors — an
   * invite award's breakdown is people, and a button promising titles over a list of
   * names is the kind of small dishonesty that costs trust in the number beside it.
   */
  const hasTitles =
    current?.kind === 'streak'
      ? (streakTitles.data?.length ?? 0) > 0
      : Boolean(
          openBreakdownFor(current, facts.data)?.sections.some((section) =>
            section.rows.some((row) => row.posterPath),
          ),
        );

  if (!current) {
    return (
      <Screen edges={['left', 'right']}>
        <View style={styles.empty}>
          <Button label="Done" onPress={() => router.back()} />
        </View>
      </Screen>
    );
  }

  return (
    /**
     * **No top inset**, and that is the founder's grey band.
     *
     * This is a `presentation: 'modal'` screen with `headerShown`, so the navigator has
     * already cleared the status bar. `Screen`'s default top edge added the inset a
     * second time, which put a tall empty strip of Paper between the app bar and the
     * poster wall. The wall starts directly under the header now.
     */
    <Screen edges={['left', 'right']}>
      {grid && grid.posters.length ? <CelebrationBackdrop grid={grid} /> : null}
      <View style={styles.body}>
        {pages.length > 1 ? (
          <ScrollView
            horizontal
            pagingEnabled
            showsHorizontalScrollIndicator={false}
            // Read off the offset rather than tracked per card: one number, and it is the
            // same number whether the reader swiped or flicked past two.
            onMomentumScrollEnd={(event) =>
              setPage(Math.round(event.nativeEvent.contentOffset.x / width))
            }
            style={styles.pager}
          >
            {pages.map((item, index) => (
              <View
                key={item.kind === 'award' ? `${item.awardKey}:${item.tierKey}` : 'streak'}
                style={[styles.page, { width }]}
              >
                {item.kind === 'award' ? (
                  <CelebrationCard awardKey={item.awardKey} tierKey={item.tierKey} />
                ) : (
                  <StreakCelebrationCard weeks={item.weeks} />
                )}
                {index === 0 ? null : null}
              </View>
            ))}
          </ScrollView>
        ) : (
          <View style={[styles.page, { width }]}>
            {current.kind === 'award' ? (
              <CelebrationCard awardKey={current.awardKey} tierKey={current.tierKey} />
            ) : (
              <StreakCelebrationCard weeks={current.weeks} />
            )}
          </View>
        )}

        {/* Only when there is more than one. A "1 of 1" under a single card is the
            interface counting to one out loud. */}
        {pages.length > 1 ? (
          <Text variant="footnote" tone="secondary">
            {`${page + 1} of ${pages.length}`}
          </Text>
        ) : null}

        {/**
         * **Done takes the fill and See titles takes the outline** (founder,
         * 2026-09-06). The celebration is the experience; the contributors are optional
         * exploration, and a filled button pointing away from the moment would be the
         * app hurrying somebody past their own achievement.
         *
         * Next rather than Done while there is another page, so a reader with two
         * awards and a streak is never told the flow has ended before it has.
         */}
        <View style={styles.actions}>
          {hasTitles ? (
            <View style={styles.half}>
              <Button
                label="See titles"
                kind="secondary"
                fit
                onPress={() => setInspecting(page)}
              />
            </View>
          ) : null}
          <View style={styles.half}>
            <Button
              label={last ? 'Done' : 'Next'}
              fit
              onPress={() => (last ? router.back() : setPage((current) => current + 1))}
            />
          </View>
        </View>
      </View>

      {/* The canonical contributing-title list — the same sheet the Awards shelf opens,
          not a second one built for this screen. */}
      {openBreakdown ? (
        <AwardBreakdownSheet
          award={openBreakdown.award}
          breakdown={openBreakdown.breakdown}
          onPressTitle={(id) => {
            setInspecting(null);
            router.push(`/title/${id}`);
          }}
          onClose={() => setInspecting(null)}
        />
      ) : null}
    </Screen>
  );
}

/** The breakdown for a page, without opening it — used to decide whether to offer it. */
function openBreakdownFor(item: Page | undefined, data: ReturnType<typeof useAwards>['data']) {
  if (!item || item.kind !== 'award' || !data) return null;
  const track = AWARD_TRACKS.find((candidate) => candidate.key === item.awardKey);
  const progress = data.awards.find((a) => a.trackKey === item.awardKey);
  if (!track || !progress) return null;
  return breakdownFor(track, data.facts, progress);
}

const styles = StyleSheet.create({
  body: { flex: 1, justifyContent: 'center', alignItems: 'center', gap: theme.space[4] },
  // `flexGrow: 0` so the pager takes the height of a card rather than the whole screen,
  // which is what keeps the actions under the card instead of at the bottom edge.
  pager: { flexGrow: 0 },
  page: { justifyContent: 'center', paddingHorizontal: theme.space[6] },
  actions: {
    flexDirection: 'row',
    gap: theme.space[2],
    alignSelf: 'stretch',
    paddingHorizontal: theme.layout.gutter,
  },
  half: { flex: 1 },
  empty: { flex: 1, justifyContent: 'flex-end', padding: theme.layout.gutter },
});
