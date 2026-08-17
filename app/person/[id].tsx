import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { ScrollView, StyleSheet, View } from 'react-native';

import { usePerson } from '@/features/person/use-person';
import { posterUri, profileUri } from '@/lib/images';
import { fullTitle } from '@/lib/titles';
import {
  Avatar,
  DetailHeaderTitle,
  EmptyState,
  LoadingScreen,
  Screen,
  SectionHeader,
  Text,
  TitleRow,
  useDetailHeader,
} from '@/ui/components';
import { theme } from '@/ui/tokens';

/**
 * A person, reached by tapping a face in a cast strip.
 *
 * Its one job is to answer "what else of theirs do I have here", so it is a portrait,
 * a name, and a list of titles — not a biography. There is no biography to show: the
 * app holds credits and no person facet, and a page padded out with a birthplace it
 * would have to start fetching is scope pretending to be completeness.
 *
 * A person the catalogue has never been enriched for renders the empty state rather
 * than a page about an id. That happens honestly today — the seed catalogue is
 * Wikidata's and carries no credits at all, so this page is empty until TMDB
 * enrichment has run over the titles someone has actually opened.
 */
export default function PersonScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const person = usePerson(id ?? null);
  const header = useDetailHeader();
  // Read once, so the header's render callback closes over a value rather than over
  // a query result that could be refetched to null between renders.
  const name = person.data?.name ?? null;

  return (
    <Screen includeBottomInset edges={[]}>
      <Stack.Screen
        options={{
          headerShown: true,
          // `title` still carries the name for the iOS back label and for screen
          // readers announcing the route; `headerTitle` is what is drawn, and it is
          // empty while the portrait and the name below it are on screen. This page
          // used to print the name in the bar directly above the same name in
          // `title1` — see `useDetailHeader` for the shared rule.
          title: name ?? '',
          headerTitle:
            header.revealed && name ? () => <DetailHeaderTitle title={name} /> : '',
          headerBackTitle: 'Back',
        }}
      />

      {person.isPending ? (
        <LoadingScreen />
      ) : person.isError ? (
        <EmptyState
          kind="couldNotLoad"
          title="Could not load this person"
          body="Check your connection and try again."
          action={{ label: 'Try again', onPress: () => void person.refetch() }}
        />
      ) : !person.data ? (
        <EmptyState
          kind="nothingYet"
          title="Nothing here yet"
          body="Open a film or season they appear in, and their credits will fill in."
        />
      ) : (
        <ScrollView
          contentContainerStyle={styles.content}
          onScroll={header.onScroll}
          scrollEventThrottle={header.scrollEventThrottle}
        >
          <View style={styles.identity} onLayout={header.onIdentityLayout}>
            <Avatar
              size="lg"
              uri={profileUri(person.data.profilePath)}
              name={person.data.name}
            />
            <Text variant="title1" style={styles.name}>
              {person.data.name}
            </Text>
          </View>

          {person.data.credits.length ? (
            <View style={styles.section}>
              <SectionHeader title="In your catalogue" />
              {person.data.credits.map((credit) => (
                <TitleRow
                  key={credit.mediaItemId}
                  title={
                    fullTitle({
                      kind: credit.kind,
                      title: credit.title,
                      seriesTitle: credit.seriesTitle,
                    }) ?? credit.title
                  }
                  year={credit.year}
                  posterUri={posterUri(credit.posterPath)}
                  secondary={credit.role}
                  onPress={() => router.push(`/title/${credit.mediaItemId}`)}
                />
              ))}
            </View>
          ) : (
            <EmptyState
              kind="nothingYet"
              compact
              title="No titles yet"
              body="Nothing they worked on has been added here."
            />
          )}
        </ScrollView>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { paddingBottom: theme.space[10] },
  identity: {
    alignItems: 'center',
    gap: theme.space[3],
    paddingHorizontal: theme.layout.gutter,
    paddingTop: theme.space[4],
    paddingBottom: theme.space[5],
  },
  name: { textAlign: 'center' },
  section: { gap: theme.space[2] },
});
