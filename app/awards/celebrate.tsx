import { useLocalSearchParams, useRouter } from 'expo-router';
import { useMemo, useState } from 'react';
import { ScrollView, StyleSheet, View, useWindowDimensions } from 'react-native';

import { useCurrentProfile } from '@/features/auth';
import { CelebrationBackdrop } from '@/features/awards/CelebrationBackdrop';
import { CelebrationCard } from '@/features/awards/CelebrationCard';
import { celebrationGrid } from '@/features/awards/celebration-posters';
import { breakdownFor } from '@/features/awards/progress';
import { AWARD_TRACKS } from '@/features/awards/tracks';
import { useAwardUnlocks } from '@/features/awards/use-award-unlocks';
import { useAwards } from '@/features/awards/use-awards';
import { Button, Screen, Text } from '@/ui/components';
import { theme } from '@/ui/tokens';

/**
 * One award earned, or several from a single ranking, as the payoff for earning it.
 *
 * ---------------------------------------------------------------------------
 * THE CONTRACT WITH THE RANKING, WHICH IS THAT THERE ISN'T ONE
 *
 * A ranking is finished before this route exists. The award was granted by a database
 * trigger inside the ranking's own transaction; `useNewUnlocks` only *reads* what that
 * trigger recorded, and the navigation here happens after the ranking sheet has already
 * closed. So every failure mode of this screen — a poster that will not load, a fact
 * read that errors, an award key this bundle has never heard of, this file throwing
 * outright — leaves a ranking that succeeded, a collection that moved, and an award on
 * the ledger. Nothing here grants anything, so nothing here can grant it twice.
 *
 * Done is unconditional for the same reason: it is `router.back()` and nothing else, so
 * it cannot be blocked by a read that never finished.
 * ---------------------------------------------------------------------------
 *
 * **Reached two ways, and both hand it the same thing.** A ranking that crossed a tier
 * pushes here with the keys it detected; an award notification in the inbox pushes here
 * with the key and tier the row already carries. There is no third source of truth — the
 * URL names the awards and this screen renders them.
 *
 * **Several awards are one flow.** One ranking can cross a Movies threshold and a
 * combined Movies-and-TV threshold in the same breath, and two modals stacked on each
 * other is two things to dismiss for one accomplishment. They page horizontally, with
 * one Done at the end and a position line only when there is more than one.
 */
export default function AwardCelebrationScreen() {
  const router = useRouter();
  const profile = useCurrentProfile();
  const { awards: param } = useLocalSearchParams<{ awards?: string }>();
  const { width } = useWindowDimensions();
  const [page, setPage] = useState(0);

  /**
   * `award:tier,award:tier` — the smallest thing that names an achievement.
   *
   * `(award_key, tier_key)` is the ledger's own identity for a tier, minus the user id,
   * which this screen takes from the session rather than from the URL. A malformed or
   * missing parameter yields an empty list and the screen closes itself: an award
   * celebration with no award is not a state worth rendering.
   */
  const awards = useMemo(() => {
    return (param ?? '')
      .split(',')
      .map((pair) => pair.split(':'))
      .filter(
        (parts): parts is [string, string] =>
          parts.length === 2 && Boolean(parts[0]) && Boolean(parts[1]),
      )
      .map(([awardKey, tierKey]) => ({ awardKey, tierKey }));
  }, [param]);

  /**
   * The facts behind the posters.
   *
   * The same read the Awards sheet uses, so the wall behind an award is built from the
   * titles that its own breakdown counts. Unavailable, still loading, or failed all mean
   * the same thing here: no wall. The card is the message and it does not need one.
   */
  const facts = useAwards(profile.id, profile.id);
  /**
   * The ledger, for one field: when each tier was crossed.
   *
   * Not for identity — the URL carries that — and not for permission. It narrows the
   * poster candidates to titles the reader already had when the award was earned, so a
   * wall opened from a notification next month is still the collection as it was. The
   * ledger is owner-read-only and this screen is always the owner's own, by construction:
   * `profile.id` on both sides. A read that fails leaves `asOf` null, which widens the
   * candidates rather than emptying them.
   */
  const unlocks = useAwardUnlocks(profile.id);

  const current = awards[Math.min(page, Math.max(0, awards.length - 1))];

  const grid = useMemo(() => {
    if (!current || !facts.data) return null;
    const track = AWARD_TRACKS.find((candidate) => candidate.key === current.awardKey);
    const progress = facts.data.awards.find((a) => a.trackKey === current.awardKey);
    /**
     * The award's own contributing titles, where it has any.
     *
     * `breakdownFor` is the same call the metric is measured from, so a poster on this
     * wall is a title that genuinely counted toward the award being celebrated. A track
     * that is not about titles — invites, comments, reactions — returns rows with no
     * poster, and `celebrationGrid` falls through to the collection.
     */
    const contributing =
      track && progress
        ? breakdownFor(track, facts.data.facts, progress).sections.flatMap((s) => s.rows)
        : [];

    return celebrationGrid({
      contributing,
      collection: facts.data.facts.watched,
      awardKey: current.awardKey,
      tierKey: current.tierKey,
      asOf:
        unlocks.data?.find(
          (row) => row.awardKey === current.awardKey && row.tierKey === current.tierKey,
        )?.earnedAt ?? null,
    });
  }, [current, facts.data, unlocks.data]);

  if (!current) {
    return (
      <Screen>
        <View style={styles.empty}>
          <Button label="Done" onPress={() => router.back()} />
        </View>
      </Screen>
    );
  }

  return (
    <Screen>
      {grid && grid.posters.length ? <CelebrationBackdrop grid={grid} /> : null}
      <View style={styles.body}>
        {awards.length > 1 ? (
          <ScrollView
            horizontal
            pagingEnabled
            showsHorizontalScrollIndicator={false}
            // Read off the offset rather than tracked per card: one number, and it is
            // the same number whether the reader swiped or flicked past two.
            onMomentumScrollEnd={(event) =>
              setPage(Math.round(event.nativeEvent.contentOffset.x / width))
            }
            style={styles.pager}
          >
            {awards.map((award) => (
              <View key={`${award.awardKey}:${award.tierKey}`} style={[styles.page, { width }]}>
                <CelebrationCard awardKey={award.awardKey} tierKey={award.tierKey} />
              </View>
            ))}
          </ScrollView>
        ) : (
          <View style={[styles.page, { width }]}>
            <CelebrationCard awardKey={current.awardKey} tierKey={current.tierKey} />
          </View>
        )}

        {/* Only when there is more than one. A "1 of 1" under a single award is the
            interface counting to one out loud. */}
        {awards.length > 1 ? (
          <Text variant="footnote" tone="secondary">
            {`${page + 1} of ${awards.length}`}
          </Text>
        ) : null}

        {/* One Done for the whole flow, however many awards it holds. */}
        <View style={styles.done}>
          <Button label="Done" onPress={() => router.back()} />
        </View>
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  body: { flex: 1, justifyContent: 'center', alignItems: 'center', gap: theme.space[4] },
  // `flexGrow: 0` so the pager takes the height of a card rather than the whole screen,
  // which is what keeps Done under the card instead of at the bottom edge.
  pager: { flexGrow: 0 },
  page: { justifyContent: 'center', paddingHorizontal: theme.space[6] },
  done: { alignSelf: 'stretch', paddingHorizontal: theme.layout.gutter },
  empty: { flex: 1, justifyContent: 'flex-end', padding: theme.layout.gutter },
});
