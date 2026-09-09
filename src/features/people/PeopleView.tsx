import Ionicons from '@expo/vector-icons/Ionicons';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';

import { FollowControl } from '@/features/profile/FollowControl';
import { useRelationships } from '@/features/profile/use-social';
import { track, type PeopleSuggestionMode } from '@/lib/analytics';
import { Avatar, Chip, Divider, EmptyState, Sheet, SkeletonRow, Text, UserRow } from '@/ui/components';
import { fontFamily, theme } from '@/ui/tokens';

import {
  MUTUALS_WITH_PAGE,
  matchLine,
  mutualsLine,
  useMutualsWith,
  usePeopleMutuals,
  usePeopleTasteMatches,
  type PersonSuggestion,
} from './use-people';

/**
 * People — the third mode of the Feed tab (founder tranche 2026-09-08 §§A2–A6).
 *
 * ---------------------------------------------------------------------------
 * WHERE THIS USED TO LIVE, AND WHY IT MOVED
 *
 * It was a category of For You, behind the Movies / TV shows dropdown, and the argument
 * for that was good: For You answers "what next", and the honest answer is sometimes a
 * person. What the founder's pre-distribution pass established is that the *activation*
 * problem is different from the what-next problem. Somebody who has just joined does not
 * open For You looking for people; the risk is that they never connect with anybody they
 * actually know, and a surface behind a dropdown on a recommendations screen is not where
 * that gets fixed.
 *
 * So People is now a peer of Feed and Leaderboard — the tab that is already about other
 * people — reached by the same compact control, and For You is titles only (§A16). Still
 * not a sixth tab: five is the width of the bar, and that has not changed.
 *
 * ---------------------------------------------------------------------------
 * WHY IT IS DRAWN AS A SIBLING OF THE LEADERBOARD
 *
 * §A3, and it is a decision about legibility rather than about taste. The two surfaces
 * share one control, so they have to share one page shape or the control reads as
 * switching between two different apps: the same margins, the same header rhythm, the same
 * row density, the same avatar size, the same name-over-handle hierarchy, the same
 * dividers. The heading sits exactly where `THIS MONTH ▼` sits, in the Feed's content
 * header row opposite the toggle — see `app/(tabs)/feed.tsx`, which owns that row.
 *
 * **The heading has no chevron.** `PEOPLE YOU MAY KNOW` is drawn with `SectionHeader` and
 * not with a `MediumSelector`, because there is no header-level choice to make yet and a
 * chevron that opens nothing is a control that lies. If a second header-level list ever
 * exists (Everyone, Nearby, From contacts) this becomes a selector and the row does not
 * move.
 *
 * **The rows are not numbered.** A leaderboard is a competition and a suggestion list is
 * not; ranking suggestions 1, 2, 3 would say the first one is the best person, which is
 * not a claim this data supports or that anybody asked for.
 *
 * ---------------------------------------------------------------------------
 * TWO LISTS, AND THEY ANSWER DIFFERENT QUESTIONS ON PURPOSE
 *
 * **Mutuals** is relationship-driven: people followed by people you follow, most shared
 * connections first. It may name a *private* account the viewer is allowed to discover,
 * which is the founder's §21C from 2026-08-28 and is unchanged here — a friend of a friend
 * is socially grounded, the row carries the private marker, and the control offers Request.
 *
 * **Match** is algorithmic: people whose rankings agree with yours, and it is
 * **public-only**. That asymmetry is the whole privacy decision of §§A4–A5: a private
 * account may be searched for deliberately and may surface through social proximity, but
 * it must never be recommended to an unrelated stranger because a correlation came out
 * high. It is enforced in `people_taste_matches` (`20260912000100`), not here — a client
 * that filtered would be a rule two places could disagree about.
 *
 * *From contacts* is the obvious third and is **deliberately not built**. It needs an
 * address-book permission, and asking for one is a decision about what bingd. uploads
 * about people who never signed up. The requirements are recorded in the PRD; there is no
 * code for it here and no permission in the manifest.
 *
 * ---------------------------------------------------------------------------
 * DISCOVERY, NOT A PROFILE
 *
 * A row is an avatar, a name, a handle, one line of context and one control. No bios, no
 * posters, no recent activity, no follower counts — the founder ruled out the last one by
 * name, and it is the one that would turn this into a popularity board. Everything a
 * reader wants beyond that is one tap away on the profile, except *who the mutual is*,
 * which the context line says and which a sheet lists in full.
 */

const MODES = [
  { id: 'mutuals', label: 'Mutuals' },
  /**
   * **`Match`, singular** (§A3). It was `Matches`, which reads as a count of things; the
   * word this app uses for the number itself is Match — `91% Match` on the Leaderboard,
   * on the profile, and on the row below — so the chip and the thing it filters to now
   * use one word.
   */
  { id: 'match', label: 'Match' },
] as const satisfies readonly { id: PeopleSuggestionMode; label: string }[];

/**
 * The default, exported so the Feed can name it in `people_suggestions_viewed` without
 * this component having to report its own initial state upwards.
 */
export const DEFAULT_PEOPLE_MODE: PeopleSuggestionMode = 'mutuals';

export function PeopleView({ viewerId }: { viewerId: string }) {
  const [mode, setMode] = useState<PeopleSuggestionMode>(DEFAULT_PEOPLE_MODE);
  // The person whose mutual list is open, or nobody. The sheet is mounted only while
  // open, per the heavy-sheet convention — its query runs when somebody asks.
  const [inspecting, setInspecting] = useState<PersonSuggestion | null>(null);

  const mutuals = usePeopleMutuals(viewerId);
  const matches = usePeopleTasteMatches(viewerId);
  const active = mode === 'mutuals' ? mutuals : matches;
  const people = active.data ?? [];

  /**
   * Only a genuine change, and the same rule the Leaderboard's metric chips follow:
   * re-tapping the chip you are on would measure fidgeting rather than a decision.
   */
  const changeMode = (next: PeopleSuggestionMode) => {
    if (next === mode) return;
    setMode(next);
    track({ name: 'people_suggestions_mode_changed', props: { mode: next } });
  };

  /**
   * One round trip for every suggestion either mode holds, rather than one per row.
   *
   * The control has to know where the reader already stands with each person —
   * `Follow`, `Requested`, `Following` — and `follow_state_with` answers for a set.
   * Both modes at once, so switching chips redraws instantly instead of refetching.
   * Nothing here infers the relationship from the fact that somebody was suggested:
   * both server functions exclude accounts the caller already follows, but the list is
   * cached and a follow made from it must redraw as Following rather than vanish
   * mid-scroll.
   */
  const everyone = [...(mutuals.data ?? []), ...(matches.data ?? [])];
  const relationships = useRelationships(
    everyone.map((person) => person.id),
    viewerId,
  );

  if (mutuals.isPending || matches.isPending) {
    return (
      <View style={styles.padded}>
        <SkeletonRow count={4} />
      </View>
    );
  }

  if (mutuals.isError && matches.isError) {
    return (
      <View style={styles.padded}>
        <EmptyState
          kind="couldNotLoad"
          title="Could not load suggestions"
          body="Check your connection and try again."
          action={{
            label: 'Try again',
            onPress: () => {
              void mutuals.refetch();
              void matches.refetch();
            },
          }}
        />
      </View>
    );
  }

  if (
    !mutuals.isError &&
    !matches.isError &&
    mutuals.data?.length === 0 &&
    matches.data?.length === 0
  ) {
    /**
     * One sentence, said once, and no chips over it: both suggestion sources are empty
     * for the same reason on a new account — no follows to walk, and not enough shared
     * rankings for a match — and two chips switching between two empty states would be
     * a control for choosing which nothing to look at. The founder's instruction was to
     * be concise and not to nag, so there is no call to action and no second attempt at
     * it further down the screen.
     *
     * Both reads must have *succeeded* to say it (review 60): `.data?.length` is
     * undefined for a failed source, so one error plus one genuine empty falls through
     * to the chips, where the errored mode shows its retry and the other its truth.
     * `isError` is checked as well (review 60b), because a failed *refetch* keeps the
     * cached array while flagging the error — cached emptiness plus a failure is still
     * a failure, not a quiet nothing.
     */
    return (
      <View style={styles.padded}>
        <EmptyState
          kind="nothingYet"
          title="No suggestions yet"
          body="Rank more titles and follow people to improve suggestions."
        />
      </View>
    );
  }

  return (
    <View style={styles.body}>
      {/* The heading is `PEOPLE YOU MAY KNOW` and it lives in the screen's content header
          row rather than here — see `app/(tabs)/feed.tsx`, exactly as the Leaderboard's
          timeframe does. This component draws the list beneath it. */}

      {/* The Leaderboard's own metric row, in the same place with the same component, so a
          reader who has met one has met both. Two short words fit on one line at every
          text size this app supports. */}
      <View style={styles.chips}>
        {MODES.map((option) => (
          <Chip
            key={option.id}
            label={option.label}
            selected={option.id === mode}
            onPress={() => changeMode(option.id)}
          />
        ))}
      </View>

      {people.length === 0 ? (
        <View style={styles.padded}>
          {active.isError ? (
            <EmptyState
              kind="couldNotLoad"
              title="Could not load suggestions"
              body="Check your connection and try again."
              action={{ label: 'Try again', onPress: () => void active.refetch() }}
            />
          ) : mode === 'mutuals' ? (
            // Each mode says why *it* is empty, because the reasons differ and the cure
            // the reader can act on differs with them.
            <EmptyState
              kind="nothingYet"
              title="No mutuals yet"
              body="Follow people, and the people they follow appear here."
            />
          ) : (
            <EmptyState
              kind="nothingYet"
              title="No matches yet"
              body="Rank more titles to find people who share your taste."
            />
          )}
        </View>
      ) : (
        <View>
          {people.map((person, index) => (
            <View key={person.id}>
              {index > 0 ? <Divider /> : null}
              <PersonRow
                person={person}
                viewerId={viewerId}
                relationship={relationships.data?.get(person.id)}
                onInspectMutuals={() => setInspecting(person)}
              />
            </View>
          ))}
        </View>
      )}

      {inspecting ? (
        <MutualsSheet
          person={inspecting}
          viewerId={viewerId}
          onClose={() => setInspecting(null)}
        />
      ) : null}
    </View>
  );
}

/**
 * One suggestion, in the Leaderboard's row language minus the rank and the count.
 *
 * Name and handle share the first line with the lock beside them, the second line is the
 * reason this row is here, and the control is at the end where the Leaderboard puts its
 * number. That is what makes the two lists read as one page shape (§A3).
 *
 * **The control is outside the identity's press target**, which `UserRow` would not allow:
 * that component carries a documented rule that a follow control never appears in it,
 * because a search result is a thing you tapped by accident on the way to somebody else
 * and a relationship started by mis-tap is one the other person is notified about. A
 * discovery list is the case that rule was not written for — following from here *is* the
 * purpose of the screen — so the rule is inverted deliberately, in a second row, rather
 * than by editing the one search depends on.
 */
function PersonRow({
  person,
  viewerId,
  relationship,
  onInspectMutuals,
}: {
  person: PersonSuggestion;
  viewerId: string;
  relationship: Parameters<typeof FollowControl>[0]['relationship'];
  onInspectMutuals: () => void;
}) {
  const router = useRouter();
  const context =
    person.context.kind === 'mutuals' ? mutualsLine(person.context) : matchLine(person.context);

  return (
    <View style={styles.row}>
      {/* The identity is the tap target and the control is not inside it, so a thumb
          reaching for Follow cannot navigate instead. */}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={[
          person.name,
          `@${person.username}`,
          // The word, where the row shows a glyph. The same treatment `LeaderboardView`
          // and `FollowListSheet` use.
          person.isPrivate ? 'Private' : null,
          context,
        ]
          .filter(Boolean)
          .join(', ')}
        accessibilityHint={
          person.isPrivate
            ? 'Opens their private profile, where you can ask to follow'
            : 'Opens their profile'
        }
        onPress={() => router.push(`/u/${person.username}`)}
        style={({ pressed }) => [styles.identity, pressed && styles.pressed]}
      >
        <Avatar size="sm" uri={person.avatarUri} name={person.name} />
        <View style={styles.copy}>
          {/* Name and handle on one baseline, the Leaderboard's arrangement: the name keeps
              its intrinsic width and the handle shrinks first, so a long display name costs
              the handle rather than pushing the control off the row. */}
          <View style={styles.line}>
            <Text variant="callout" numberOfLines={1} style={styles.name}>
              {person.name}
            </Text>
            <Text variant="caption" tone="tertiary" numberOfLines={1} style={styles.handle}>
              @{person.username}
            </Text>
            {/* The same lock the follower lists and the Leaderboard draw. A private account
                can be a mutual suggestion (§A4), and without a marker the tap is a surprise
                — a row that looks like every other one and opens a locked shell. The screen
                reader gets the word, above. */}
            {person.isPrivate ? (
              <Ionicons
                name="lock-closed"
                size={theme.layout.icon.sm - 8}
                color={theme.text.tertiary}
                accessibilityElementsHidden
              />
            ) : null}
          </View>

          {/* Maroon, because it is the reason this row is here rather than a fact about the
              account. One line, and never both a count and a percentage: two numbers
              measuring different things side by side invite a comparison neither supports.
              For a mutual suggestion the line is its own press target — nested
              deliberately, the inner one winning the touch — because the question it
              answers ("who?") opens the mutual list, not the profile. */}
          {person.context.kind === 'mutuals' ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`See mutuals with ${person.name}`}
              accessibilityHint="Opens the list of people you both know"
              onPress={onInspectMutuals}
              hitSlop={theme.space[1]}
              style={({ pressed }) => pressed && styles.pressed}
            >
              <Text variant="caption" tone="action" numberOfLines={1}>
                {context}
              </Text>
            </Pressable>
          ) : (
            <Text variant="caption" tone="action" numberOfLines={1}>
              {context}
            </Text>
          )}
        </View>
      </Pressable>

      <FollowControl
        userId={person.id}
        name={person.name}
        viewerId={viewerId}
        relationship={relationship}
        isSelf={false}
        surface="people"
        size="compact"
      />
    </View>
  );
}

/**
 * The list behind a card's mutual line.
 *
 * `UserRow` on purpose: these rows are informational — who the shared connections are —
 * and the no-follow-control rule that component enforces is exactly right here. The
 * follow decision belongs to the profile a row opens, and the suggestion the sheet came
 * from already carries its own control.
 *
 * Every name the server returns is an edge `follows_read` already admits to this
 * viewer; the sheet adds reachability, not visibility (`20260827000100`).
 */
function MutualsSheet({
  person,
  viewerId,
  onClose,
}: {
  person: PersonSuggestion;
  viewerId: string;
  onClose: () => void;
}) {
  const router = useRouter();
  const list = useMutualsWith(person.id, viewerId);

  return (
    <Sheet visible onClose={onClose} label={`Mutuals with ${person.name}`}>
      <Text variant="title2" style={styles.sheetTitle}>
        Mutuals with {person.name}
      </Text>
      {list.isPending ? (
        <SkeletonRow count={2} />
      ) : list.isError ? (
        <EmptyState
          kind="couldNotLoad"
          compact
          title="Could not load mutuals"
          body="Check your connection and try again."
          action={{ label: 'Try again', onPress: () => void list.refetch() }}
        />
      ) : (
        <ScrollView style={styles.sheetList}>
          {(list.data ?? []).map((mutual) => (
            <UserRow
              key={mutual.id}
              name={mutual.name}
              username={mutual.username}
              avatarUri={mutual.avatarUri}
              onPress={() => {
                onClose();
                router.push(`/u/${mutual.username}`);
              }}
            />
          ))}
          {/* The read is one page and the card's count is not capped (review 60b):
              a full page says so rather than leaving the reader to count. */}
          {(list.data?.length ?? 0) >= MUTUALS_WITH_PAGE ? (
            <Text variant="footnote" tone="secondary" style={styles.sheetTruncation}>
              Showing the first {MUTUALS_WITH_PAGE}.
            </Text>
          ) : null}
        </ScrollView>
      )}
    </Sheet>
  );
}

const styles = StyleSheet.create({
  // `LeaderboardView`'s own body padding, so the two modes end the same distance above
  // the tab bar.
  body: { paddingBottom: theme.space[6] },
  chips: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: theme.space[2],
    paddingHorizontal: theme.layout.gutter,
    paddingTop: theme.space[3],
    paddingBottom: theme.space[2],
  },
  padded: { paddingHorizontal: theme.layout.gutter, paddingTop: theme.space[4] },
  // The Leaderboard row's metrics, minus the rank column.
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space[3],
    paddingHorizontal: theme.layout.gutter,
    paddingVertical: theme.space[3],
  },
  identity: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: theme.space[3] },
  copy: { flex: 1, gap: 1 },
  line: { flexDirection: 'row', alignItems: 'baseline', gap: theme.space[2] },
  name: { flexShrink: 0, fontFamily: fontFamily.sansSemibold },
  handle: { flexShrink: 1 },
  pressed: { opacity: 0.7 },
  sheetTitle: { paddingHorizontal: theme.layout.gutter, paddingBottom: theme.space[2] },
  sheetList: { maxHeight: 360 },
  sheetTruncation: { paddingHorizontal: theme.layout.gutter, paddingTop: theme.space[2] },
});
