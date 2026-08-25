import { useRouter } from 'expo-router';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';

import { FollowControl } from '@/features/profile/FollowControl';
import { useRelationships } from '@/features/profile/use-social';
import { Avatar, EmptyState, SectionHeader, SkeletonRow, Text } from '@/ui/components';
import { fontFamily, theme } from '@/ui/tokens';

import {
  peopleSections,
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
 * person. `Titles` keeps everything For You already was, including recommendation
 * requests; `People` is this.
 *
 * ---------------------------------------------------------------------------
 * TWO SECTIONS AND NO THIRD
 *
 * Mutuals is the follow graph: people followed by people you follow. Taste matches is
 * the ranking graph, scored by `taste_match` itself rather than by anything invented
 * for this screen.
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
 * want beyond that is one tap away on the profile, and a discovery list that duplicates
 * the profile is a list nobody can scan.
 */
export function PeopleDiscovery({ viewerId }: { viewerId: string }) {
  const mutuals = usePeopleMutuals(viewerId);
  const matches = usePeopleTasteMatches(viewerId);

  const sections = peopleSections(mutuals.data, matches.data);
  const everyone = sections.flatMap((section) => section.people);

  /**
   * One round trip for every suggestion on screen, rather than one per row.
   *
   * The control has to know where the reader already stands with each person —
   * `Follow`, `Requested`, `Following` — and `follow_state_with` answers for a set.
   * Nothing here infers the relationship from the fact that somebody was suggested:
   * both server functions exclude accounts the caller already follows, but the list is
   * cached and a follow made from it must redraw as Following rather than vanish
   * mid-scroll.
   */
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

  if (sections.length === 0) {
    /**
     * One sentence, said once, and never as a banner over a list that has content.
     *
     * It names the two things that genuinely improve the answer, because both suggestion
     * sources are empty for the same reason on a new account: no follows to walk, and
     * not enough shared rankings for a match. The founder's instruction was to be
     * concise and not to nag, so there is no call to action and no second attempt at it
     * further down the screen.
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
    <ScrollView contentContainerStyle={styles.content}>
      {sections.map((section) => (
        <View key={section.title}>
          {/* Only for a section that has people in it. `peopleSections` drops the empty
              one entirely rather than drawing a heading over nothing, which is why there
              is no conditional here. */}
          <SectionHeader title={section.title} />
          {section.people.map((person) => (
            <PersonRow
              key={person.id}
              person={person}
              viewerId={viewerId}
              relationship={relationships.data?.get(person.id)}
            />
          ))}
        </View>
      ))}
    </ScrollView>
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
}: {
  person: PersonSuggestion;
  viewerId: string;
  relationship: Parameters<typeof FollowControl>[0]['relationship'];
}) {
  const router = useRouter();
  const context =
    person.context.kind === 'mutuals'
      ? `${person.context.count} ${person.context.count === 1 ? 'mutual' : 'mutuals'}`
      : `${person.context.score}% Match`;

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
              the account. One line, and never both a count and a percentage. */}
          <Text variant="caption" tone="action" numberOfLines={1}>
            {context}
          </Text>
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

const styles = StyleSheet.create({
  content: { paddingBottom: theme.space[6] },
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
});
