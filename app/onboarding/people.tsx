import { Ionicons } from '@expo/vector-icons';
import { Stack, useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';

import { useCurrentProfile } from '@/features/auth';
import { OnboardingFooter } from '@/features/onboarding/OnboardingFooter';
import { OnboardingHeader } from '@/features/onboarding/OnboardingHeader';
import {
  starterLine,
  useStarterPeople,
  type StarterPerson,
} from '@/features/onboarding/use-starter-people';
import { useAdvanceStage } from '@/features/onboarding/use-onboarding-stage';
import { useStepViewed } from '@/features/onboarding/step-viewed';
import { mutualsLine } from '@/features/people/use-people';
import { FollowControl } from '@/features/profile/FollowControl';
import { InviteFriendsButton } from '@/features/profile/InviteFriendsButton';
import { useRelationships } from '@/features/profile/use-social';
import { useDebounced } from '@/features/search/use-title-search';
import {
  meaningfulMatch,
  memberQuery,
  useUserSearch,
  type UserResult,
} from '@/features/search/use-user-search';
import { track, type PeopleStepVariant } from '@/lib/analytics';
import { fontFamily, theme } from '@/ui/tokens';
import {
  Avatar,
  Button,
  SearchField,
  SectionHeader,
  Screen,
  SkeletonRow,
  Text,
} from '@/ui/components';

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
 * - **Find your friends.** No inviter. A search for people the reader already knows, then
 *   strangers under *Suggested for you*, described by facts.
 * - **Could not load.** The read failed. The title is neutral on purpose — `Find your
 *   friends` would assert the account is organic and `You're already connected` would
 *   assert it is not, and the read failed, so neither is known.
 *
 * ---------------------------------------------------------------------------
 * FIND SOMEBODY YOU KNOW, FIRST (Onboarding 2.0, OB-6, 2026-11-14)
 *
 * On both the invited and the organic branch a `@username` search sits directly under the
 * intro, because the people a reader most wants to follow are people they already know,
 * and a list of strangers cannot contain them. Results draw **in place** of the branch's
 * list while the field has text, with the same row and the same `FollowControl` at
 * `surface: 'onboarding'`; clearing the field brings the branch back. A row opens nothing:
 * routing holds the account in the flow, so a pushed profile would be replaced, and the
 * row carries no open action — which is also why it emits no
 * `member_search_result_opened`. Following from it is `follow_created`, as everywhere.
 * The failed read keeps its own screen and no search: its sentence points at the Feed tab.
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
  /**
   * `onboarding_step_viewed` (OB-1), once the branch is decided — a list, the invited
   * acknowledgment, or the failure — and never for the skeleton in front of them.
   */
  useStepViewed(profile.id, 'people', !isPending || isError);
  const relationships = useRelationships(ids, profile.id);

  /**
   * The `@username` search (OB-6). The field is live; the request runs on the debounced
   * value, as the title search does, and `memberQuery` strips a leading `@` so `jo` and
   * `@jo` ask for the same handle. The viewer is excluded and the Search tab's relevance
   * rule (`meaningfulMatch`) decides who is shown.
   */
  const [query, setQuery] = useState('');
  const settledQuery = useDebounced(query);
  const searching = memberQuery(query).text.length > 0;
  const search = useUserSearch(settledQuery, profile.id);
  const found = searching
    ? (search.data ?? []).filter(
        (user) => user.id !== profile.id && meaningfulMatch(user, settledQuery),
      )
    : [];
  const foundRelationships = useRelationships(
    found.map((user) => user.id),
    profile.id,
  );
  const results = searching ? (
    <SearchResults
      pending={search.isPending || (query !== settledQuery && !search.data)}
      failed={search.isError}
      onRetry={() => void search.refetch()}
      found={found}
      viewerId={profile.id}
      relationships={foundRelationships.data}
    />
  ) : null;

  /**
   * What `onboarding_people_search_used` reports on the way out (OB-1/OB-6): how many
   * distinct trimmed queries came back, and whether any found somebody other than the
   * viewer. Refs, because nothing renders from them. A query counts once whether it came
   * back with rows, with none, or with an error — each is a search that was used.
   */
  const searched = useRef(new Set<string>());
  const searchFound = useRef(false);
  const searchedText = memberQuery(settledQuery).text;
  const { isSuccess, isError: searchFailed, isPlaceholderData, data: rows } = search;
  useEffect(() => {
    if (!searchedText || isPlaceholderData) return;
    if (isSuccess) {
      searched.current.add(searchedText);
      if (rows.some((user) => user.id !== profile.id)) searchFound.current = true;
    } else if (searchFailed) {
      searched.current.add(searchedText);
    }
  }, [searchedText, isSuccess, searchFailed, isPlaceholderData, rows, profile.id]);

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

  const left = useRef(false);
  const leave = () => {
    // Continue always works, with or without a query typed; the guard only keeps a second
    // press from reporting the step twice.
    if (left.current) return;
    left.current = true;
    if (searched.current.size > 0) {
      track({
        name: 'onboarding_people_search_used',
        props: { searches: searched.current.size, had_results: searchFound.current },
      });
    }
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

      <ScrollView
        contentContainerStyle={styles.body}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
      >
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

            <PeopleSearch value={query} onChange={setQuery} />
            {results}

            {/* No control. They are already followed in both directions, and the state is
                stated rather than offered. Held back while a search is drawing in its place. */}
            {searching ? null : (
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
            )}

            {searching ? null : people.length > 0 ? (
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
              {/* Not `Find your people`. The list below is strangers, and calling them the
                  reader's people would be the screen lying in its first three words. `Find
                  your friends` is true now because the search directly under it is for
                  people the reader already knows, and the strangers are labelled for what
                  they are: *Suggested for you* (OB-6, 2026-11-14). */}
              <Text variant="title1">Find your friends</Text>
              <Text variant="body" tone="secondary">
                Follow people you know to see what they rank and send each other picks.
              </Text>
            </View>

            <PeopleSearch value={query} onChange={setQuery} />
            {searching ? (
              results
            ) : people.length === 0 ? (
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
              <>
                <SectionHeader title="Suggested for you" />
                {people.map((person) => (
                  <PersonRow
                    key={person.id}
                    person={person}
                    viewerId={profile.id}
                    relationship={relationships.data?.get(person.id)}
                  />
                ))}
              </>
            )}
          </>
        )}
      </ScrollView>

      <OnboardingFooter>
        {/* Secondary to following, and present on every branch that has a list: inviting
            somebody is the other way this step can succeed. Outlined rather than filled
            (OB-6), so Continue is the footer's one Maroon fill. */}
        {!isError && people.length > 0 ? <InviteFriendsButton kind="secondary" /> : null}
        <Button label="Continue" onPress={leave} />
      </OnboardingFooter>
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
      <Text variant="title1">People on bingd</Text>
      <Text variant="body" tone="secondary">
        We couldn&apos;t load suggestions just now. You can find people from the Feed tab
        later.
      </Text>
      <View style={styles.retry}>
        <Button label="Try again" kind="secondary" onPress={onRetry} />
      </View>
    </View>
  );
}

/** The `@username` field under the intro (OB-6): the shared `SearchField`, unchanged. */
function PeopleSearch({
  value,
  onChange,
}: {
  value: string;
  onChange: (next: string) => void;
}) {
  return (
    <View style={styles.field}>
      <SearchField
        accessibilityLabel="Search people by username"
        placeholder="Search by @username"
        value={value}
        onChangeText={onChange}
        onClear={() => onChange('')}
        autoCapitalize="none"
        autoCorrect={false}
        returnKeyType="search"
      />
    </View>
  );
}

/**
 * What the search found, drawn in place of the branch's list (OB-6).
 *
 * Four states and no fifth: a skeleton while the first answer is out, the connection line
 * with a retry, an honest "nobody" that points at the other way this step succeeds, or
 * the rows. A row is the step's own person row, with the same `FollowControl` — so a
 * private account is offered the request it always is.
 */
function SearchResults({
  pending,
  failed,
  onRetry,
  found,
  viewerId,
  relationships,
}: {
  pending: boolean;
  failed: boolean;
  onRetry: () => void;
  found: UserResult[];
  viewerId: string;
  relationships:
    ReadonlyMap<string, Parameters<typeof FollowControl>[0]['relationship']> | undefined;
}) {
  if (failed) {
    return (
      <View style={styles.searchStatus}>
        <Text variant="body" tone="secondary">
          Search needs a connection.
        </Text>
        <View style={styles.searchRetry}>
          <Button label="Try again" kind="secondary" size="sm" fit onPress={onRetry} />
        </View>
      </View>
    );
  }
  if (pending) return <SkeletonRow count={2} />;
  if (found.length === 0) {
    return (
      <View style={styles.searchStatus}>
        <Text variant="body" tone="secondary">
          No one by that name yet. Invite them instead.
        </Text>
      </View>
    );
  }
  return (
    <>
      {found.map((user) => (
        <FoundRow
          key={user.id}
          user={user}
          viewerId={viewerId}
          relationship={relationships?.get(user.id)}
        />
      ))}
    </>
  );
}

/**
 * One person the search found, styled as the step's suggestion rows are. No context line:
 * a search result is here because it was asked for, not because of shared titles.
 */
function FoundRow({
  user,
  viewerId,
  relationship,
}: {
  user: UserResult;
  viewerId: string;
  relationship: Parameters<typeof FollowControl>[0]['relationship'];
}) {
  const isPrivate = user.visibility === 'private';
  return (
    <View style={styles.row}>
      <Avatar uri={user.avatarUri} name={user.name} size="md" />
      <View style={styles.identity}>
        <View style={styles.nameLine}>
          <Text variant="body" style={styles.name} numberOfLines={1}>
            {user.name}
          </Text>
          {isPrivate ? (
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
          {isPrivate ? `@${user.username} · Private` : `@${user.username}`}
        </Text>
      </View>
      <FollowControl
        userId={user.id}
        name={user.name}
        viewerId={viewerId}
        relationship={relationship}
        isSelf={false}
        surface="onboarding"
        size="compact"
      />
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
  // `space[3]` under the drawn field; the field's own 44pt box carries its clear target.
  field: { paddingHorizontal: theme.layout.gutter, paddingBottom: theme.space[3] },
  searchStatus: { paddingHorizontal: theme.layout.gutter, gap: theme.space[3] },
  searchRetry: { alignItems: 'flex-start' },
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
});
