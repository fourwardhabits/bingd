import { Ionicons } from '@expo/vector-icons';
import { useQueryClient } from '@tanstack/react-query';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useMemo, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, View } from 'react-native';

import { useCurrentProfile } from '@/features/auth';
import { useRankedCollection, useWatchlist } from '@/features/collection/use-collection';
import { useWatched } from '@/features/collection/use-watched';
import { newOperationId, setWatchlist } from '@/features/collection/writes';
import {
  usePerson,
  usePersonFetch,
  type PersonCredit,
} from '@/features/person/use-person';
import { posterUri, profileUri } from '@/lib/images';
import { invalidateAfterWatchlistChange } from '@/features/collection/invalidate';
import { queryKeys } from '@/lib/query';
import {
  Avatar,
  DetailHeaderTitle,
  EmptyState,
  LoadingScreen,
  Screen,
  SectionHeader,
  SegmentedTabs,
  Text,
  TitleRow,
  useDetailHeader,
} from '@/ui/components';
import { theme } from '@/ui/tokens';

type Filter = 'all' | 'movie' | 'series';

/**
 * A person, reached by tapping a face in a cast strip.
 *
 * **This page used to be a filtered view of the reader's own catalogue** — "In your
 * catalogue", a heading that told somebody who had just tapped Tilda Swinton that she
 * had been in two things. The question it should answer is the one the tap asked:
 * *I like this person, what else have they worked on.* So the filmography is TMDB's,
 * cached in `person_cache`, and the adapter writes every credited title into
 * `media_items` before it writes the cache row — which means a film here is a real
 * catalogue row and opening it, ranking it or saving it is the ordinary action rather
 * than an import.
 *
 * It is built to read as a discovery surface, alongside Search, For You and the
 * Collection Wall: a portrait and a name, enough biography to place them, and then
 * rows of artwork with the year and what they did in it. The reader's own relationship
 * with each title travels with the row — Saved, Ranked, Watched — because the useful
 * next question after "what else" is "which of these have I already seen", and
 * answering it in the row is cheaper than making them open twelve pages to find out.
 *
 * The list opens at twelve and grows in twelves. TMDB's ordering is by popularity and
 * a prolific character actor's tail is single episodes of things nobody is looking
 * for, so the first screen is the part that answers the question and the rest is
 * available rather than imposed.
 */
export default function PersonScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const viewer = useCurrentProfile();
  const queryClient = useQueryClient();

  const person = usePerson(id ?? null);
  const state = person.data;
  const detail = state?.detail ?? null;

  /**
   * Two reasons to ask the adapter, and one reason not to.
   *
   * Nothing cached, or something cached that has lapsed — the second is what makes
   * the seven-day TTL real rather than a number in a migration nothing acts on
   * (independent review 13). A stale filmography still renders in full; the refresh
   * happens behind the reader.
   *
   * The reason not to is `claimed`: somebody else's request is already in flight, and
   * a second one is exactly what `tmdb_claim_person` exists to prevent. `usePerson`
   * polls in that state instead.
   */
  const awaitingClaim = person.awaitingClaim;
  // `!person.isError` matters as much as the rest of it. A read that failed tells us
  // nothing about what is cached, and "we could not ask the database" is not a reason
  // to spend a provider request — least of all while somebody else's claim may still
  // be live and simply unobservable from here.
  const needsFetch =
    !person.isPending && !person.isError && !awaitingClaim && (!detail || state?.stale === true);
  const { fetching, retry } = usePersonFetch(id ?? null, needsFetch);

  const tryAgain = () => {
    retry();
    void person.refetch();
  };

  const [filter, setFilter] = useState<Filter>('all');
  const [shown, setShown] = useState(PAGE);
  const [busyId, setBusyId] = useState<string | null>(null);

  const header = useDetailHeader();
  // Read once, so the header's render callback closes over a value rather than over a
  // query result that could be refetched to null between renders.
  const name = detail?.name ?? null;

  /**
   * The reader's own state, from queries the rest of the app has already warmed.
   *
   * Only the movie ranking is fetched. A credit is a film or a *series*, never a
   * season — TMDB credits people on shows — and a series cannot be ranked (AD-1), so
   * a "Ranked" flag against one would be a state it can never reach.
   */
  const watchlist = useWatchlist(viewer.id);
  const watched = useWatched(viewer.id);
  const rankedMovies = useRankedCollection(viewer.id, 'movies');

  const saved = useMemo(
    () => new Set((watchlist.data ?? []).map((entry) => entry.mediaItemId)),
    [watchlist.data],
  );
  const ranked = useMemo(
    () => new Set((rankedMovies.data ?? []).map((entry) => entry.mediaItemId)),
    [rankedMovies.data],
  );

  const credits = detail?.credits ?? [];
  const counts = {
    movie: credits.filter((credit) => credit.kind === 'movie').length,
    series: credits.filter((credit) => credit.kind === 'series').length,
  };
  const filtered =
    filter === 'all' ? credits : credits.filter((credit) => credit.kind === filter);
  const visible = filtered.slice(0, shown);

  // Offered only where both halves have something in them. A director with no
  // television is not asked to choose between Movies and TV — a filter with one
  // populated option is a control that can only ever narrow to what is already there.
  const filterable = counts.movie > 0 && counts.series > 0;
  const tabs = [
    { id: 'all' as const, label: 'All' },
    { id: 'movie' as const, label: 'Movies' },
    { id: 'series' as const, label: 'TV' },
  ];

  const toggleWatchlist = async (credit: PersonCredit) => {
    if (busyId) return;
    setBusyId(credit.mediaItemId);
    const present = !saved.has(credit.mediaItemId);
    const result = await setWatchlist({
      operationId: newOperationId(),
      mediaItemId: credit.mediaItemId,
      present,
    });
    setBusyId(null);

    if (result.outcome === 'failed') {
      Alert.alert('Could not update watchlist', result.message);
      return;
    }

    await Promise.all([
      // The watchlist and Queue Dragon, which counts it (`collection/invalidate.ts`).
      invalidateAfterWatchlistChange(queryClient, viewer.id),
      queryClient.invalidateQueries({ queryKey: queryKeys.title(credit.mediaItemId) }),
    ]);
  };

  return (
    <Screen includeBottomInset edges={[]}>
      <Stack.Screen
        options={{
          // `title` still carries the name for the iOS back label and for screen
          // readers announcing the route; `headerTitle` is what is drawn, and it is
          // empty while the portrait and the name below it are on screen. See
          // `useDetailHeader` for the shared rule both detail routes follow.
          headerShown: true,
          title: name ?? '',
          headerTitle:
            header.revealed && name ? () => <DetailHeaderTitle title={name} /> : '',
          headerBackTitle: 'Back',
        }}
      />

      {/* `claimed` counts as loading, and that is the point of carrying it up here:
          somebody else's request is in flight, `usePerson` is polling for its result,
          and showing "nothing here yet" in the meantime is what independent review 13
          found two concurrent readers stuck on. */}
      {person.isPending || awaitingClaim || (fetching && !detail) ? (
        <LoadingScreen />
      ) : person.isError ? (
        <EmptyState
          kind="couldNotLoad"
          title="Could not load this person"
          body="Check your connection and try again."
          action={{ label: 'Try again', onPress: tryAgain }}
        />
      ) : !detail ? (
        // Reached when the provider had nothing for this id, or the fetch failed, or
        // somebody else's claim lapsed without an answer. Honest about which it
        // cannot be: they look the same from here. `tryAgain` clears the one-attempt
        // guard, so this control genuinely asks again rather than re-reading a cache
        // that has not changed.
        <EmptyState
          kind="nothingYet"
          title="Nothing here yet"
          body="We could not load this person's work. Try again in a moment."
          action={{ label: 'Try again', onPress: tryAgain }}
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
              uri={profileUri(detail.profilePath)}
              name={detail.name}
            />
            <Text variant="title1" style={styles.centred}>
              {detail.name}
            </Text>
            {/* Known-for and the life dates, on one line, because each on its own is
                a fragment and together they place somebody. Absent entirely rather
                than shown as a dash: TMDB genuinely does not have a birthday for
                everybody, and an em dash where a date goes reads as a failure. */}
            {metaLine(detail) ? (
              <Text variant="footnote" tone="secondary" style={styles.centred}>
                {metaLine(detail)}
              </Text>
            ) : null}
          </View>

          {detail.biography ? (
            <Biography
              text={detail.biography}
              truncated={detail.biographyTruncated}
            />
          ) : null}

          <View style={styles.section}>
            <SectionHeader
              // Not "In your catalogue". This is their work, all of it that TMDB
              // knows about, and most of it will be new to the reader — which is the
              // entire point of the page.
              title="Known for"
            />

            {filterable ? (
              <View style={styles.tabs}>
                <SegmentedTabs
                  options={tabs}
                  value={filter}
                  onChange={(next) => {
                    setFilter(next);
                    // Back to the first page. Keeping the count across a filter
                    // change means switching to TV on somebody with four TV credits
                    // silently shows all four and hides the See more that explains
                    // why the list is short.
                    setShown(PAGE);
                  }}
                />
              </View>
            ) : null}

            {visible.length ? (
              visible.map((credit) => (
                <TitleRow
                  key={credit.mediaItemId}
                  title={credit.title}
                  year={credit.year}
                  posterUri={posterUri(credit.posterPath)}
                  secondary={credit.role}
                  tertiary={stateLabel(credit, { saved, ranked, watched: watched.data })}
                  onPress={() => router.push(`/title/${credit.mediaItemId}`)}
                  trailing={
                    <SaveAction
                      saved={saved.has(credit.mediaItemId)}
                      title={credit.title}
                      busy={busyId === credit.mediaItemId}
                      onPress={() => void toggleWatchlist(credit)}
                    />
                  }
                />
              ))
            ) : (
              <EmptyState
                kind="nothingYet"
                compact
                title="Nothing here"
                body="TMDB lists no credits of this kind for them."
              />
            )}

            {filtered.length > visible.length ? (
              <View style={styles.more}>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Show more of ${detail.name}'s work`}
                  onPress={() => setShown((count) => count + PAGE)}
                  hitSlop={theme.space[2]}
                >
                  <Text variant="callout" tone="action">
                    See more
                  </Text>
                </Pressable>
              </View>
            ) : null}

            {/* What is not being shown, said rather than implied. The adapter keeps
                the forty most popular credits; somebody with three hundred should not
                be presented as somebody with forty. */}
            {detail.creditTotal > credits.length ? (
              <View style={styles.more}>
                <Text variant="caption" tone="tertiary">
                  Showing {credits.length} of {detail.creditTotal} credits TMDB lists.
                </Text>
              </View>
            ) : null}
          </View>

          <View style={styles.footer}>
            <Text variant="caption" tone="tertiary">
              Metadata from TMDB
            </Text>
          </View>
        </ScrollView>
      )}
    </Screen>
  );
}

/** How many credits a page shows before "See more". */
const PAGE = 12;

/**
 * "Acting · born 1960 · Nairobi", assembled from whatever TMDB actually has.
 *
 * Every part is optional and the joiner never leaves a dangling separator, which is
 * the whole reason this is a function rather than a template in the markup.
 */
function metaLine(person: {
  knownFor: string | null;
  birthday: string | null;
  deathday: string | null;
  placeOfBirth: string | null;
}) {
  const years = person.birthday
    ? person.deathday
      ? `${person.birthday.slice(0, 4)}–${person.deathday.slice(0, 4)}`
      : `born ${person.birthday.slice(0, 4)}`
    : null;

  return [person.knownFor, years, person.placeOfBirth].filter(Boolean).join(' · ') || null;
}

/**
 * The biography, three lines until it is opened.
 *
 * Same treatment as a title's overview, deliberately: it is the same kind of block in
 * the same position doing the same job, and two different disclosure patterns for one
 * pattern of content is how a design stops being one design.
 */
function Biography({ text, truncated }: { text: string; truncated: boolean }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={expanded ? 'Collapse biography' : 'Expand biography'}
      onPress={() => setExpanded((open) => !open)}
      style={styles.block}
    >
      <Text variant="body" numberOfLines={expanded ? undefined : 3}>
        {text}
        {expanded && truncated ? '…' : ''}
      </Text>
      {/* No "less", for the reason the title page has none: once it is open the whole
          thing is visible and the control has nothing left to promise. */}
      {expanded ? null : (
        <Text variant="callout" tone="action">
          more
        </Text>
      )}
    </Pressable>
  );
}

/**
 * What the reader has already done with this title, in one word or none.
 *
 * One word, not three: a row carrying "Saved · Ranked · Watched" is a row about the
 * reader rather than about the film. Ranked wins over watched because it is the
 * stronger statement and implies it, and neither is shown for a series, which cannot
 * be ranked and whose seasons are logged individually — "Watched" against a whole
 * show would be a claim the data does not make.
 */
function stateLabel(
  credit: PersonCredit,
  state: { saved: Set<string>; ranked: Set<string>; watched: Set<string> | undefined },
) {
  if (credit.kind === 'movie') {
    if (state.ranked.has(credit.mediaItemId)) return 'Ranked';
    if (state.watched?.has(credit.mediaItemId)) return 'Watched';
  }
  if (state.saved.has(credit.mediaItemId)) return 'On your watchlist';
  return null;
}

/**
 * Save to the watchlist, from the row.
 *
 * A bookmark rather than a labelled button: this is a trailing control in a list of
 * twelve, and twelve words that all say "Watchlist" would be the loudest thing on a
 * page about somebody's work. The state is carried by the filled versus outlined
 * glyph and stated in full in the accessibility label, which is where a one-glyph
 * control has to say what it means.
 */
function SaveAction({
  saved,
  title,
  busy,
  onPress,
}: {
  saved: boolean;
  title: string;
  busy: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: saved, disabled: busy }}
      accessibilityLabel={
        saved ? `Remove ${title} from your watchlist` : `Add ${title} to your watchlist`
      }
      onPress={onPress}
      disabled={busy}
      hitSlop={theme.space[3]}
      style={({ pressed }) => [styles.save, (pressed || busy) && styles.pressed]}
    >
      <Ionicons
        name={saved ? 'bookmark' : 'bookmark-outline'}
        size={theme.layout.icon.md}
        color={theme.semantic.action}
      />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  content: { paddingBottom: theme.space[10] },
  identity: {
    alignItems: 'center',
    gap: theme.space[2],
    paddingHorizontal: theme.layout.gutter,
    paddingTop: theme.space[4],
    paddingBottom: theme.space[3],
  },
  centred: { textAlign: 'center' },
  block: {
    paddingHorizontal: theme.layout.gutter,
    paddingTop: theme.space[2],
    gap: theme.space[1],
  },
  section: { paddingTop: theme.space[5], gap: theme.space[1] },
  tabs: { paddingBottom: theme.space[2] },
  more: { paddingHorizontal: theme.layout.gutter, paddingTop: theme.space[3] },
  save: {
    minWidth: theme.layout.minTapTarget,
    minHeight: theme.layout.minTapTarget,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pressed: { opacity: 0.7 },
  footer: {
    paddingHorizontal: theme.layout.gutter,
    paddingTop: theme.space[6],
  },
});
