import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';

import { FollowControl } from '@/features/profile/FollowControl';
import { useRelationships } from '@/features/profile/use-social';
import {
  Avatar,
  EmptyState,
  FilterChip,
  Sheet,
  SkeletonRow,
  Text,
  UserRow,
} from '@/ui/components';
import { fontFamily, theme } from '@/ui/tokens';

import {
  MUTUALS_WITH_PAGE,
  mutualsLine,
  useMutualsWith,
  usePeopleMutuals,
  usePeopleTasteMatches,
  type PersonSuggestion,
} from './use-people';

/**
 * People — the second half of For You (founder tranche 2026-08-26 §§10–15).
 *
 * ---------------------------------------------------------------------------
 * WHY IT IS HERE AND NOT SOMEWHERE ELSE
 *
 * Bingd needed a social-discovery surface before the RC and had none: the only way to
 * find a person was to already know their handle and type it into search. The three
 * places it could have gone were rejected for reasons worth writing down.
 *
 * **Not injected into Feed.** The Feed is what the people you follow have done. A "You
 * may know" card interleaved with real activity makes the timeline a place where the
 * app talks about strangers, and every product that has done it has ended up with a
 * feed that is mostly suggestions.
 *
 * **Not a sixth tab.** Five is already the width of the bar.
 *
 * **A mode of For You**, which is what it actually is. For You is the screen that
 * answers "what next" — and the honest answer is sometimes a film and sometimes a
 * person. It is a third option in the category selector that screen already had, beside
 * Movies and TV shows: `Movies` and `TV shows` keep everything For You already was,
 * including recommendation requests; `People` is this.
 *
 * ---------------------------------------------------------------------------
 * TWO MODES AND NO THIRD
 *
 * Mutuals is the follow graph: people followed by people you follow. Matches is the
 * ranking graph, scored by `taste_match` itself rather than by anything invented for
 * this screen. They were two stacked sections; the founder's external-beta polish made
 * them chips — the same compact filter treatment the titles above already use — because
 * two lists answering different questions read better chosen than scrolled.
 *
 * *From contacts* is the obvious third and is **deliberately not built**. It needs an
 * address-book permission, and asking for one is a decision about what Bingd uploads
 * about people who never signed up. The requirements for ever doing it are recorded in
 * the PRD; there is no code for it here and no permission in the manifest.
 *
 * ---------------------------------------------------------------------------
 * DISCOVERY, NOT A PROFILE
 *
 * A row is an avatar, a name, a handle, one line of context and one control. No bios,
 * no posters, no recent activity, no explanation paragraph. Everything a reader would
 * want beyond that is one tap away on the profile — except *who the mutual is*, which
 * the context line itself now says ("Mutual: Abisola") and, for more than a couple, a
 * lightweight sheet lists in full. The card stays a row; the graph lives in the sheet.
 */

const MODES = [
  { id: 'mutuals', label: 'Mutuals', icon: 'people-outline' },
  { id: 'matches', label: 'Matches', icon: 'sparkles-outline' },
] as const;

type Mode = (typeof MODES)[number]['id'];

export function PeopleDiscovery({ viewerId }: { viewerId: string }) {
  const [mode, setMode] = useState<Mode>('mutuals');
  // The person whose mutual list is open, or nobody. The sheet is mounted only while
  // open, per the heavy-sheet convention — its query runs when somebody asks.
  const [inspecting, setInspecting] = useState<PersonSuggestion | null>(null);

  const mutuals = usePeopleMutuals(viewerId);
  const matches = usePeopleTasteMatches(viewerId);
  const active = mode === 'mutuals' ? mutuals : matches;
  const people = active.data ?? [];

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

  if (mutuals.isPending || matches.isPending) return <SkeletonRow count={4} />;

  if (mutuals.isError && matches.isError) {
    return (
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
      <EmptyState
        kind="nothingYet"
        title="No suggestions yet"
        body="Rank more titles and follow people to improve suggestions."
      />
    );
  }

  return (
    <>
      <View style={styles.modes}>
        {MODES.map((option) => (
          <FilterChip
            key={option.id}
            icon={option.icon}
            label={option.label}
            selected={mode === option.id}
            onPress={() => setMode(option.id)}
          />
        ))}
      </View>

      {people.length === 0 ? (
        active.isError ? (
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
        )
      ) : (
        <ScrollView contentContainerStyle={styles.content}>
          {people.map((person) => (
            <PersonRow
              key={person.id}
              person={person}
              viewerId={viewerId}
              relationship={relationships.data?.get(person.id)}
              onInspectMutuals={() => setInspecting(person)}
            />
          ))}
        </ScrollView>
      )}

      {inspecting ? (
        <MutualsSheet
          person={inspecting}
          viewerId={viewerId}
          onClose={() => setInspecting(null)}
        />
      ) : null}
    </>
  );
}

/**
 * One suggestion.
 *
 * Deliberately shaped like `UserRow` — round avatar, name over handle — so that a person
 * reads as a person wherever they appear, and never like the poster rows next door. It
 * is not `UserRow` itself for one reason, and it is a real one: that component carries a
 * documented rule that a follow control never appears inside it, because a search result
 * is a thing you tapped by accident on the way to somebody else and a relationship
 * started by mis-tap is one the other person is notified about.
 *
 * A discovery list is the case that rule was not written for. Following from here *is*
 * the purpose of the screen, and making somebody open ten profiles to follow ten people
 * is the surface not working. So: a second row, with the rule inverted deliberately
 * rather than by editing the one that search depends on.
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
    person.context.kind === 'mutuals' ? mutualsLine(person.context) : `${person.context.score}% Match`;

  return (
    <View style={styles.row}>
      {/* The identity is the tap target and the control is not inside it, so a thumb
          reaching for Follow cannot navigate instead. */}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={[person.name, `@${person.username}`, context].join(', ')}
        accessibilityHint="Opens their profile"
        onPress={() => router.push(`/u/${person.username}`)}
        style={({ pressed }) => [styles.identity, pressed && styles.pressed]}
      >
        <Avatar size="sm" uri={person.avatarUri} name={person.name} />
        <View style={styles.copy}>
          <Text variant="callout" numberOfLines={1} style={styles.name}>
            {person.name}
          </Text>
          <Text variant="caption" tone="tertiary" numberOfLines={1}>
            @{person.username}
          </Text>
          {/* Maroon, because it is the reason this row is here rather than a fact about
              the account. One line, and never both a count and a percentage. For a
              mutual suggestion the line is its own press target — nested deliberately,
              the inner one winning the touch — because the question it answers ("who?")
              opens the mutual list, not the profile. */}
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
        surface="for_you"
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
  content: { paddingBottom: theme.space[6] },
  modes: {
    flexDirection: 'row',
    gap: theme.space[2],
    paddingHorizontal: theme.layout.gutter,
    paddingBottom: theme.space[2],
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space[3],
    paddingHorizontal: theme.layout.gutter,
    paddingVertical: theme.space[2],
    minHeight: theme.layout.rowMinHeight,
  },
  identity: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: theme.space[3] },
  copy: { flex: 1, gap: 2 },
  name: { fontFamily: fontFamily.sansSemibold },
  pressed: { opacity: 0.7 },
  sheetTitle: { paddingHorizontal: theme.layout.gutter, paddingBottom: theme.space[2] },
  sheetList: { maxHeight: 360 },
  sheetTruncation: { paddingHorizontal: theme.layout.gutter, paddingTop: theme.space[2] },
});
