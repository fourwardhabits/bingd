import { Ionicons } from '@expo/vector-icons';
import { Stack, useRouter } from 'expo-router';
import { useEffect, useRef } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';

import { useCurrentProfile } from '@/features/auth';
import { OnboardingHeader } from '@/features/onboarding/OnboardingHeader';
import {
  starterLine,
  useStarterPeople,
  type StarterPerson,
} from '@/features/onboarding/use-starter-people';
import { useAdvanceStage } from '@/features/onboarding/use-onboarding-stage';
import { mutualsLine } from '@/features/people/use-people';
import { FollowControl } from '@/features/profile/FollowControl';
import { InviteFriendsButton } from '@/features/profile/InviteFriendsButton';
import { useRelationships } from '@/features/profile/use-social';
import { track, type PeopleStepVariant } from '@/lib/analytics';
import { fontFamily, theme } from '@/ui/tokens';
import { Avatar, Button, SectionHeader, Screen, SkeletonRow, Text } from '@/ui/components';

/**
 * Step 9: the social step, and the one the founder's Connectedness metric actually runs on.
 *
 * ---------------------------------------------------------------------------
 * THREE STATES, AND THE THIRD IS NOT AN EMPTY LIST
 *
 * `use-starter-people.ts` decides which. What this screen owns is that the three are drawn
 * as three genuinely different sentences:
 *
 * - **Connected.** Somebody arrived on an invitation. The connection is acknowledged
 *   before anything is asked, and the inviter's row carries **no control**: they are
 *   already followed in both directions, and a Follow button there is the flow forgetting
 *   what redemption just did.
 * - **Start your Feed.** No inviter. Strangers, described by facts.
 * - **Could not load.** The read failed. The title is neutral on purpose — `Start your
 *   Feed` would assert the account is organic and `You're already connected` would assert
 *   it is not, and the read failed, so neither is known.
 *
 * ---------------------------------------------------------------------------
 * NO PERCENTAGE, AND NO EXPLANATION OF WHY THERE ISN'T ONE
 *
 * Match cannot appear here and the screen does not say so. An account that has just
 * finished the ranking run has ranked exactly five movies, and `taste.min_common` is 5, so
 * to be scored against anybody they would have to have ranked all five of *the same*
 * movies. The floor is not lowered to populate a screen: `20260827001000` exists to stop
 * thin evidence reading as certainty.
 *
 * An earlier draft carried a line explaining that. It was accurate and it was the wrong
 * screen for it — explaining an absent feature in somebody's first minutes teaches a
 * limitation instead of a benefit. Taste Match introduces itself later, when it has
 * something to say.
 *
 * ---------------------------------------------------------------------------
 * NOTHING HERE BLOCKS
 *
 * No follow-all, nothing preselected, no counter and no target. Continue always works, on
 * every branch including the failure, which is the lesson of the build-4 stranding: this
 * step must never be the reason somebody cannot reach the app. A graph made of
 * relationships nobody chose is worth nothing to the product that depends on it.
 */
export default function PeopleStepScreen() {
  const router = useRouter();
  const profile = useCurrentProfile();
  const advance = useAdvanceStage(profile.id);

  const { data, isPending, isError, refetch } = useStarterPeople(profile.id);

  const people = data?.people ?? [];
  const ids = people.map((person) => person.id);
  const relationships = useRelationships(ids, profile.id);

  /**
   * The branch the reader actually met, reported once.
   *
   * A `could_not_load` that was retried into a real list still reports `could_not_load`,
   * because the question this answers is what the screen said to somebody — not what it
   * eventually became. A ref rather than state: nothing renders from it, and it exists
   * only to make the report happen once per visit.
   */
  const met = useRef<PeopleStepVariant | null>(null);
  useEffect(() => {
    if (met.current) return;
    if (isError) met.current = 'could_not_load';
    else if (data) met.current = data.variant;
  }, [data, isError]);

  const leave = () => {
    track({
      name: 'onboarding_step_completed',
      props: {
        step: 'people',
        variant: met.current ?? undefined,
        // Following is optional, so leaving without one is not a skip: `outcome` is about
        // whether the step was completed, and it always is.
        outcome: 'continued',
      },
    });
    advance('notifications');
    router.replace('/onboarding/notifications');
  };

  return (
    <Screen>
      <Stack.Screen options={{ headerShown: false }} />
      <OnboardingHeader step="people" />

      <ScrollView contentContainerStyle={styles.body}>
        {isError ? (
          <CouldNotLoad onRetry={() => void refetch()} />
        ) : isPending ? (
          <SkeletonRow count={4} />
        ) : data?.inviter ? (
          <>
            <View style={styles.intro}>
              <Text variant="title1">You&apos;re already connected</Text>
              <Text variant="body" tone="secondary">
                {data.inviter.name} invited you to bingd.
              </Text>
            </View>

            {/* No control. They are already followed in both directions, and the state is
                stated rather than offered. */}
            <View style={styles.inviterRow}>
              <Avatar uri={data.inviter.avatarUri} name={data.inviter.name} size="md" />
              <View style={styles.identity}>
                <Text variant="body" style={styles.name} numberOfLines={1}>
                  {data.inviter.name}
                </Text>
                <Text variant="footnote" tone="secondary" numberOfLines={1}>
                  @{data.inviter.username}
                </Text>
                <Text variant="footnote" tone="secondary">
                  {data.inviter.connection === 'mutual'
                    ? 'Following each other'
                    : data.inviter.connection === 'following'
                      ? 'Following'
                      : 'They invited you'}
                </Text>
              </View>
            </View>

            {people.length > 0 ? (
              <>
                <SectionHeader title="People you may know" />
                {people.map((person) => (
                  <PersonRow
                    key={person.id}
                    person={person}
                    viewerId={profile.id}
                    relationship={relationships.data?.get(person.id)}
                  />
                ))}
              </>
            ) : (
              /* No candidates: the acknowledgment stands on its own and the offer becomes
                 an invitation. There is no empty list and no "no suggestions yet". */
              <View style={styles.alone}>
                <SectionHeader title="Bring somebody with you" />
                <View style={styles.aloneBody}>
                  <Text variant="body" tone="secondary">
                    Your Feed fills up faster with the people you actually watch things with.
                  </Text>
                  <InviteFriendsButton />
                </View>
              </View>
            )}
          </>
        ) : (
          <>
            <View style={styles.intro}>
              {/* Not `Find your people`. These are strangers, and a heading calling them
                  the reader's people is the screen lying in its first three words.
                  `Start your Feed` names the outcome of following instead. */}
              <Text variant="title1">Start your Feed</Text>
              <Text variant="body" tone="secondary">
                Follow a few people to see what they&apos;re loving and find ideas for what to
                watch next.
              </Text>
            </View>

            {people.length === 0 ? (
              /* A genuinely empty read, which is not the same as a failed one. Nobody is
                 told they are alone; the offer is simply the one that still makes sense. */
              <View style={styles.alone}>
                <SectionHeader title="Bring somebody with you" />
                <View style={styles.aloneBody}>
                  <Text variant="body" tone="secondary">
                    Your Feed fills up faster with the people you actually watch things with.
                  </Text>
                  <InviteFriendsButton />
                </View>
              </View>
            ) : (
              people.map((person) => (
                <PersonRow
                  key={person.id}
                  person={person}
                  viewerId={profile.id}
                  relationship={relationships.data?.get(person.id)}
                />
              ))
            )}
          </>
        )}
      </ScrollView>

      <View style={styles.footer}>
        {/* Secondary to following, and present on every branch that has a list: inviting
            somebody is the other way this step can succeed. */}
        {!isError && people.length > 0 ? <InviteFriendsButton /> : null}
        <Button label="Continue" onPress={leave} />
      </View>
    </Screen>
  );
}

/**
 * The read failed, said as a failure.
 *
 * `Try again` and `Continue`, and Continue works. The step must never be the reason
 * somebody cannot reach the app.
 */
function CouldNotLoad({ onRetry }: { onRetry: () => void }) {
  return (
    <View style={styles.intro}>
      <Text variant="title1">People on bingd.</Text>
      <Text variant="body" tone="secondary">
        We could not load suggestions just now. You can find people from the Feed tab once
        you are in.
      </Text>
      <View style={styles.retry}>
        <Button label="Try again" kind="secondary" onPress={onRetry} />
      </View>
    </View>
  );
}

/**
 * One suggestion.
 *
 * The control is the app's own `FollowControl` at `compact`, with `surface="onboarding"` —
 * which is what makes step 9's contribution to Connectedness separable from every other
 * way somebody follows anybody, with no new analytics event. It also means a private
 * account reached through a mutual walk offers **Request** rather than Follow, without this
 * screen knowing anything about follow states.
 */
function PersonRow({
  person,
  viewerId,
  relationship,
}: {
  person: StarterPerson;
  viewerId: string;
  relationship: Parameters<typeof FollowControl>[0]['relationship'];
}) {
  const context =
    person.context.kind === 'mutuals' ? mutualsLine(person.context) : starterLine(person.context);

  return (
    <View style={styles.row}>
      <Avatar uri={person.avatarUri} name={person.name} size="md" />
      <View style={styles.identity}>
        <View style={styles.nameLine}>
          <Text variant="body" style={styles.name} numberOfLines={1}>
            {person.name}
          </Text>
          {person.isPrivate ? (
            <Ionicons
              name="lock-closed"
              size={12}
              color={theme.text.secondary}
              // The lock is decoration; `Private` is spoken as part of the row's label.
              accessibilityElementsHidden
              importantForAccessibility="no"
            />
          ) : null}
        </View>
        <Text variant="footnote" tone="secondary" numberOfLines={1}>
          {person.isPrivate ? `@${person.username} · Private` : `@${person.username}`}
        </Text>
        <Text variant="footnote" tone="secondary" numberOfLines={1}>
          {context}
        </Text>
      </View>
      <FollowControl
        userId={person.id}
        name={person.name}
        viewerId={viewerId}
        relationship={relationship}
        isSelf={false}
        surface="onboarding"
        size="compact"
      />
    </View>
  );
}

const styles = StyleSheet.create({
  body: { paddingBottom: theme.space[6] },
  intro: {
    paddingHorizontal: theme.layout.gutter,
    paddingTop: theme.space[3],
    paddingBottom: theme.space[4],
    gap: theme.space[2],
  },
  retry: { paddingTop: theme.space[2] },
  inviterRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space[3],
    marginHorizontal: theme.layout.gutter,
    marginBottom: theme.space[4],
    padding: theme.space[3],
    borderRadius: theme.radius.control,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.border.hairline,
    backgroundColor: theme.surface.raised,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space[3],
    paddingHorizontal: theme.layout.gutter,
    paddingVertical: theme.space[2],
  },
  identity: { flex: 1, gap: 2 },
  nameLine: { flexDirection: 'row', alignItems: 'center', gap: theme.space[1] },
  name: { flexShrink: 1, fontFamily: fontFamily.sansSemibold },
  alone: { paddingBottom: theme.space[4] },
  aloneBody: { paddingHorizontal: theme.layout.gutter, gap: theme.space[3] },
  footer: {
    paddingHorizontal: theme.layout.gutter,
    paddingVertical: theme.space[3],
    gap: theme.space[2],
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.border.hairline,
  },
});
