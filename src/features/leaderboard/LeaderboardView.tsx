import Ionicons from '@expo/vector-icons/Ionicons';
import { Pressable, StyleSheet, View } from 'react-native';

import {
  Avatar,
  Divider,
  EmptyState,
  MediumSelector,
  SegmentedTabs,
  SkeletonRow,
  Text,
} from '@/ui/components';
import { fontFamily, theme, tier } from '@/ui/tokens';

import {
  countLabel,
  emptyCopy,
  LEADERBOARD_METRICS,
  LEADERBOARD_TIMEFRAMES,
  type LeaderboardEntry,
  type LeaderboardMetric,
  type LeaderboardTimeframe,
  type MyStanding,
} from './use-leaderboard';

export type LeaderboardViewProps = {
  metric: LeaderboardMetric;
  onChangeMetric: (next: LeaderboardMetric) => void;
  timeframe: LeaderboardTimeframe;
  onChangeTimeframe: (next: LeaderboardTimeframe) => void;
  entries: readonly LeaderboardEntry[] | undefined;
  standing: MyStanding | undefined;
  loading: boolean;
  /**
   * The rows on screen belong to the previous metric or timeframe and the next one is still
   * loading. They stay put so the board does not jump; the container says it is busy so a
   * screen reader does not read counts that are about to be replaced as current.
   */
  updating?: boolean;
  onPressPerson: (username: string) => void;
};

/**
 * The monthly board (founder §§7–10).
 *
 * ---------------------------------------------------------------------------
 * WHAT IT DELIBERATELY IS NOT
 *
 * No podium illustration, no confetti, no XP, no points economy, no streak multiplier,
 * no all-time column. The founder ruled each out by name, and the reason they belong in
 * a comment rather than in a design doc is that every one of them is the *obvious* next
 * thing to add to a leaderboard — so the absence has to be a decision somebody can read,
 * or it will be filled in by the next person who thinks the screen looks bare.
 *
 * What is left is a heading, four chips and a list. The restraint is the design.
 *
 * ---------------------------------------------------------------------------
 * THE TOP THREE, AND WHY THE TREATMENT IS A COLOUR RATHER THAN A MEDAL
 *
 * The founder allowed "a restrained medal/rank treatment for top three". A gold/silver/
 * bronze palette would be three new colours in an app with a two-colour system, so the
 * top three get the app's own accent on their rank instead: same mark, same weight,
 * carrying the one colour the design already spends on things that matter.
 *
 * It keys on `rank`, not on position in the array — so a three-way tie for first shows
 * three accented rows and the fourth person is fourth, which is what the board says.
 *
 * **Gold, silver and bronze medals since the marquee cohesion sprint** (founder,
 * 2026-11-07): the first three ranks are drawn as a medal holding the number — see
 * `RankMedal` — and fourth onward as the plain number. They replaced the trophy that sat
 * beside first place, so no row shows a mark and a number for the same fact.
 *
 * ---------------------------------------------------------------------------
 * THE "YOU" ROW
 *
 * `is_you` marks the reader's row wherever it lands. When their rank is past the end of
 * the page, `standing` supplies it and a pinned row is drawn beneath the list instead.
 * The two are mutually exclusive by construction — the pinned row is drawn only when no
 * visible row carries `isYou` — so the reader can never see themselves twice, which is
 * the confusion the founder named.
 */
export function LeaderboardView({
  metric,
  onChangeMetric,
  timeframe,
  onChangeTimeframe,
  entries,
  standing,
  loading,
  updating = false,
  onPressPerson,
}: LeaderboardViewProps) {
  const rows = entries ?? [];
  const youAreListed = rows.some((entry) => entry.isYou);
  const empty = emptyCopy(metric, timeframe);

  return (
    <View style={styles.body}>
      {/* LEADERBOARD is the section's heading, in the screen's content header row — see
          `app/(tabs)/feed.tsx`. This component draws the board beneath it. */}

      {/**
       * **All | Movies | TV | Reviews, four equal segments that always fit** (founder, nav
       * cohesion sprint, 2026-11-06). The chips ran past the screen edge at 360pt and
       * Reviews was reached by scrolling. Collection's Watched | Watchlist control, in its
       * dense form: one hairline track, the chosen segment Parchment with a Maroon word,
       * each a 44pt target. At a large text size a word shrinks to fit its segment rather
       * than clipping. The spoken names stay whole: All Titles, TV Shows.
       *
       * Re-choosing the segment already chosen is not a change, as before.
       */}
      <View style={styles.categories}>
        <SegmentedTabs
          variant="nav"
          dense
          accessibilityLabel="Leaderboard category"
          options={LEADERBOARD_METRICS.map((option) => ({
            id: option.value,
            label: option.short,
            accessibilityLabel: option.label,
          }))}
          value={metric}
          onChange={(next) => {
            if (next !== metric) onChangeMetric(next);
          }}
        />
      </View>

      {/**
       * **The time range, as a secondary filter** (same sprint): a compact
       * text-and-chevron under the categories, opening a two-line menu beside it rather
       * than a sheet. It was the row's uppercase Maroon heading. The one place the
       * timeframe is named, still (founder §3), and the same remembered preference.
       */}
      <View style={styles.timeframe}>
        <MediumSelector
          size="filter"
          value={timeframe}
          onChange={onChangeTimeframe}
          options={LEADERBOARD_TIMEFRAMES}
          accessibilityHint="Choose a time range"
          testID="leaderboard-timeframe"
        />
      </View>

      {/**
        * **One content container for every state and every metric** (founder physical QA,
        * 2026-09-14).
        *
        * Switching Titles · Movies · TV · Reviews moved the board. The loading and empty
        * states each sat in a wrapper with 16pt of extra top padding and a second horizontal
        * inset — `SkeletonRow` already pads its own rows to the gutter — and the loading
        * state drew eighteen skeleton rows (three `SkeletonRow`s of six). So a switch went
        * rows at the top → a taller skeleton 16pt lower → rows at the top again. And a metric
        * with nobody on it drew `EmptyState` at full size, whose `title2` heading read as a
        * section header that the metrics with rows did not have — which is the "Titles looks
        * different" the founder saw: Titles usually has rows, and a sparse metric usually
        * does not.
        *
        * Now every state starts in this container at the same top, and nothing between the
        * container and each state adds an offset of its own: rows, the skeleton's rows and
        * the compact empty state each carry only their own component padding. The empty
        * state is the compact one, so no metric grows a heading the others lack. What still
        * differs between metrics is row content, which is the one difference the board is
        * allowed.
        */}
      <View testID="leaderboard-content" accessibilityState={{ busy: updating }}>
        {loading ? (
          <SkeletonRow count={5} />
        ) : rows.length === 0 ? (
          <View testID="leaderboard-empty">
            <EmptyState kind="nothingYet" compact title={empty.title} body={empty.body} />
          </View>
        ) : (
          rows.map((entry, index) => (
            <View key={entry.id}>
              {index > 0 ? <Divider /> : null}
              <LeaderboardRow entry={entry} metric={metric} onPress={onPressPerson} />
            </View>
          ))
        )}
      </View>

      {/* Only when they are not already above. A second copy of a row the reader can
          see is the duplication the founder asked to avoid, and `isYou` is what makes
          the two cases exclusive rather than merely unlikely. */}
      {!loading && !youAreListed && standing && standing.rank !== null ? (
        <View style={styles.pinned}>
          <Divider />
          <YouRow standing={standing} metric={metric} />
        </View>
      ) : null}
    </View>
  );
}

/**
 * **A medal for ranks 1, 2 and 3: the number inside a ring of gold, silver or bronze**
 * (founder, marquee cohesion sprint, 2026-11-07).
 *
 * The metals are the award tiers' (`tier` in the colour tokens), which the design system
 * keeps off text and out from behind it — so the metal is the ring and the number stays
 * Ink on the row's own ground, legible at any contrast setting. Colour is not the only
 * carrier: the number is in the medal.
 *
 * It keys on `rank`, never on position, so ties share a medal: two people level for
 * second are both silver, and the next person is 4th with no bronze — competition ranking,
 * as the server computes it. Hidden from a screen reader, which hears "Number 2" from the
 * row.
 */
const MEDAL = 26;
const MEDALS: Record<number, string> = { 1: tier.gold, 2: tier.silver, 3: tier.bronze };

function RankMedal({ rank }: { rank: number }) {
  return (
    <View
      style={[styles.medal, { borderColor: MEDALS[rank] }]}
      testID={`leaderboard-medal-${rank}`}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      <Text variant="footnote" style={styles.medalNumber} allowFontScaling={false}>
        {rank}
      </Text>
    </View>
  );
}

function LeaderboardRow({
  entry,
  metric,
  onPress,
}: {
  entry: LeaderboardEntry;
  metric: LeaderboardMetric;
  onPress: (username: string) => void;
}) {
  const top = entry.rank <= 3;
  const secondary = secondLine(entry);

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={[
        `Number ${entry.rank}`,
        entry.name,
        `@${entry.username}`,
        // The word, where the row shows a glyph. Same treatment as `FollowListSheet`.
        entry.isPrivate && !entry.isYou ? 'Private' : null,
        countLabel(metric, entry.count),
        entry.isYou ? 'You' : secondary,
      ]
        .filter(Boolean)
        .join(', ')}
      accessibilityHint={
        entry.isYou
          ? 'Opens your profile'
          : entry.viewable
            ? 'Opens their profile'
            : // Named, because the destination is genuinely different: a locked shell
              // with a Follow request on it rather than a collection.
              'Opens their private profile, where you can ask to follow'
      }
      onPress={() => onPress(entry.username)}
      style={({ pressed }) => [
        styles.row,
        entry.isYou && styles.rowYou,
        pressed && styles.pressed,
      ]}
    >
      <View style={styles.rankCell}>
        {top ? (
          <RankMedal rank={entry.rank} />
        ) : (
          <Text variant="callout" tone="tertiary" style={styles.rank} allowFontScaling={false}>
            {entry.rank}
          </Text>
        )}
      </View>

      <Avatar size="sm" uri={entry.avatarUri} name={entry.name} />

      <View style={styles.copy}>
        {/**
          * **Name and handle share the first line** (founder row-polish §1).
          *
          * They were stacked, which spent the row's second line on a handle and left
          * nowhere for the thing a leaderboard is actually useful for — who this person
          * is to *you*. The name is primary and takes whatever width it needs; the handle
          * is muted and shrinks first, so a long display name pushes the handle out
          * rather than pushing the count off the row.
          */}
        <View style={styles.identity}>
          <Text variant="callout" numberOfLines={1} style={styles.name}>
            {entry.name}
          </Text>
          <Text variant="caption" tone="tertiary" numberOfLines={1} style={styles.handle}>
            @{entry.username}
          </Text>
          {/**
            * **The lock, and it is the same one the follower lists draw.**
            *
            * A private account is on this board since 20260902000100, and without a
            * marker the tap is a surprise -- a row that looks like every other one and
            * opens to a locked shell. `FollowListSheet` met exactly this when
            * `followers_of` started including private accounts, and settled on a glyph
            * beside the handle rather than the word: the row is already carrying a rank,
            * a name, a handle, a second line and a count, and "Private" spelled out in
            * it competes with all five. The screen reader gets the word, above.
            *
            * Not on the reader's own row. Somebody with a private account knows.
            */}
          {entry.isPrivate && !entry.isYou ? (
            <Ionicons
              name="lock-closed"
              size={theme.layout.icon.sm - 8}
              color={theme.text.tertiary}
              accessibilityElementsHidden
            />
          ) : null}
        </View>

        {/**
          * **The second line is Match and its evidence** — or, on the reader's own row,
          * the word You.
          *
          * Secondary by size and tone on purpose: this is a leaderboard, and the two
          * things that must read first are who the person is and what they scored. Match
          * is the reason to tap, not the reason the row exists.
          *
          * Nothing is drawn for the reader themselves beyond "You": a 100% match with
          * your own catalogue is a tautology, `taste_match` refuses the case, and an
          * empty `Match TBD · 0 shared` placeholder on your own row would be the feature
          * looking broken at exactly the row you look at first.
          */}
        {entry.isYou ? (
          <Text variant="caption" tone="tertiary" numberOfLines={1}>
            You
          </Text>
        ) : secondary ? (
          <Text
            variant="caption"
            tone={entry.matchPercent !== null ? 'action' : 'tertiary'}
            numberOfLines={1}
          >
            {secondary}
          </Text>
        ) : null}
      </View>

      <Text variant="callout" numberOfLines={1} style={styles.count} allowFontScaling={false}>
        {entry.count}
      </Text>
    </Pressable>
  );
}

/**
 * `91% Match · 37 shared`, or `Match TBD · 3 shared`.
 *
 * The same two forms the profile uses, in the same order, from the same `taste_match`
 * row -- so a reader who has met one has met both, and the two surfaces cannot come to
 * disagree about what "shared" counts.
 *
 * Null for the reader's own row, where the caller draws "You" instead.
 *
 * **Null for a row the caller may not read**, which is a private account they have not
 * been approved by. There is nothing to say: the server sent no Match and no shared
 * count for that row, because Match is computed over two collections and this reader has
 * not been let into one of them. `Match TBD` would be the wrong sentence -- it means
 * "not enough overlap yet", which is a fact about two catalogues rather than about
 * permission, and drawing it here would invite somebody to wait for a number that is
 * never coming. The row is a name and a count, and the lock beside the handle is what
 * explains why.
 *
 * Checked on `sharedCount` as well as on `viewable`: the two are set by the same
 * server projection, and a line that read `Match TBD · null shared` because one of them
 * was missed is the kind of defect that only appears on somebody else's phone.
 */
export function secondLine(entry: LeaderboardEntry): string | null {
  if (entry.isYou) return null;
  if (!entry.viewable || entry.sharedCount === null) return null;
  const shared = `${entry.sharedCount} shared`;
  return entry.matchPercent === null
    ? `Match TBD · ${shared}`
    : `${entry.matchPercent}% Match · ${shared}`;
}

/**
 * The reader's own position, when it is past the end of the page.
 *
 * Not a control. Every other row opens a profile and this one would open the reader's
 * own, which the tab bar already does — and a row that looks like the others and goes
 * somewhere they would not expect is worse than one that goes nowhere.
 */
function YouRow({ standing, metric }: { standing: MyStanding; metric: LeaderboardMetric }) {
  return (
    <View
      style={[styles.row, styles.rowYou]}
      accessibilityLabel={`You are number ${standing.rank} of ${standing.entrants}, ${countLabel(
        metric,
        standing.count,
      )}`}
    >
      <View style={styles.rankCell}>
        <Text variant="callout" tone="tertiary" style={styles.rank} allowFontScaling={false}>
          {standing.rank}
        </Text>
      </View>
      <View style={styles.copy}>
        <Text variant="callout">You</Text>
        {/* The denominator, because a rank without one is a number a reader cannot
            place — 84th of 96 and 84th of 4,000 are different pieces of news. */}
        <Text variant="caption" tone="tertiary">
          of {standing.entrants}
        </Text>
      </View>
      <Text variant="callout">{standing.count}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  body: { paddingBottom: theme.space[6] },
  heading: { paddingHorizontal: theme.layout.gutter, paddingTop: theme.space[4] },
  // Its own height and no more: a horizontal ScrollView otherwise grows in a column.
  categories: { paddingTop: theme.space[2] },
  // The filter's 44pt target, on the gutter, directly under the categories: a filter of
  // the board, not a row of its own (marquee cohesion sprint).
  timeframe: {
    flexDirection: 'row',
    paddingHorizontal: theme.layout.gutter,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space[3],
    paddingHorizontal: theme.layout.gutter,
    paddingVertical: theme.space[3],
  },
  rowYou: { backgroundColor: theme.surface.raised },
  // Fixed width so the avatars line up whether the rank is a medal, 4 or 48. Right-aligned
  // so the digits themselves line up, which is what makes a column of numbers scannable.
  // A minimum rather than a width: a pinned standing of 1,000 still fits on one line
  // (independent review 1).
  rankCell: { minWidth: MEDAL, alignItems: 'flex-end' },
  rank: { textAlign: 'right' },
  medal: {
    width: MEDAL,
    height: MEDAL,
    borderRadius: MEDAL / 2,
    borderWidth: 3,
    alignItems: 'center',
    justifyContent: 'center',
  },
  medalNumber: { fontFamily: fontFamily.sansSemibold, color: theme.text.primary },
  copy: { flex: 1, gap: 1 },
  // Name and handle on one baseline. The name keeps its intrinsic width and the handle
  // shrinks first, so a long display name costs the handle rather than the count.
  identity: { flexDirection: 'row', alignItems: 'baseline', gap: theme.space[2] },
  name: { flexShrink: 0 },
  handle: { flexShrink: 1 },
  // Never crushed by a long name: the count is the other thing this screen is for.
  count: { flexShrink: 0, minWidth: 28, textAlign: 'right' },
  pinned: { paddingTop: theme.space[2] },
  pressed: { opacity: 0.7 },
});
