import { Ionicons } from '@expo/vector-icons';
import { useQueryClient } from '@tanstack/react-query';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { Fragment, useMemo, useState } from 'react';
import {
  Alert,
  Animated,
  Pressable,
  StyleSheet,
  View,
  type LayoutChangeEvent,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useCurrentProfile } from '@/features/auth';
import { useRankedCollection, useWatchlist } from '@/features/collection/use-collection';
import { useWatched } from '@/features/collection/use-watched';
import { mustReconcile, newOperationId, setWatchlist } from '@/features/collection/writes';
import {
  INITIAL_FILMOGRAPHY_SORT,
  FILMOGRAPHY_AXES,
  sortCoverage,
  sortFilmography,
  tailStart,
  type CoverageGroup,
  type FilmographySort,
} from '@/features/person/filmography';
import { shortened } from '@/features/person/biography';
import { usePerson, usePersonFetch, type PersonCredit } from '@/features/person/use-person';
import { NAV_BAR_HEIGHT, TitleTopBar } from '@/features/title/TitleTopBar';
import { HERO_COLLAPSED_BAND } from '@/features/title/use-hero-reveal';
import { track } from '@/lib/analytics';
import { posterUri, profileUri } from '@/lib/images';
import { invalidateAfterWatchlistChange } from '@/features/collection/invalidate';
import { queryKeys } from '@/lib/query';
import {
  Avatar,
  ClampedText,
  ContentToolbar,
  EmptyState,
  Screen,
  SegmentedTabs,
  SkeletonRow,
  SortChip,
  SortMenu,
  Text,
  TitleHero,
  TitleRow,
  useDetailHeader,
} from '@/ui/components';
import { coerceSortState } from '@/ui/sort';
import { theme } from '@/ui/tokens';

type Filter = 'all' | 'movie' | 'series';
type Role = 'cast' | 'crew';

const ROLE_TABS = [
  { id: 'cast' as const, label: 'Cast' },
  { id: 'crew' as const, label: 'Crew' },
];

const KIND_TABS = [
  { id: 'all' as const, label: 'All' },
  { id: 'movie' as const, label: 'Movies' },
  { id: 'series' as const, label: 'TV' },
];

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
 * ---------------------------------------------------------------------------
 * THE 2026-11-11 REFRESH (founder-approved, focused rather than a redesign)
 *
 * - **The detail-page header** (design-system.md §11b). The navigator's opaque bar became
 *   `TitleTopBar` over the collapsed Parchment band — what the title page and a list
 *   without artwork already draw — with the portrait straddling the band, so a person
 *   page is no longer the one pushed page with a different top. The compact name still
 *   arrives only once the large one has gone (`useDetailHeader`'s measured rule).
 * - **Left-aligned identity**, as on the title and list pages, which also gave the
 *   biography back the vertical space a centred stack spent.
 * - **"Filmography"** rather than "Known for": the list is everything kept, and it can now
 *   be ordered — `filmography.ts` — with the shared sort control in the section's own
 *   header row.
 * - **Honest sorting.** A date sort over a capped filmography says where it
 *   stops being complete, at the row where it does (`sortCoverage`).
 * - **The biography says when it was shortened**, once opened (`Biography`).
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
    !person.isPending &&
    !person.isError &&
    !awaitingClaim &&
    (!detail || state?.stale === true);
  const { fetching, retry } = usePersonFetch(id ?? null, needsFetch);

  const tryAgain = () => {
    retry();
    void person.refetch();
  };

  const [filter, setFilter] = useState<Filter>('all');
  // Null until the reader chooses, so the page opens on whichever half they have work in.
  const [role, setRole] = useState<Role | null>(null);
  const [sort, setSort] = useState<FilmographySort>(INITIAL_FILMOGRAPHY_SORT);
  const [sortOpen, setSortOpen] = useState(false);
  const [shown, setShown] = useState(PAGE);
  const [busyId, setBusyId] = useState<string | null>(null);

  const top = usePersonTopBar();
  // Read once, so the bar closes over a value rather than over a query result that could
  // be refetched to null between renders.
  const name = detail?.name ?? null;

  /**
   * The reader's own state, from queries the rest of the app has already warmed.
   *
   * A credit is a film or a *series*, never a season — TMDB credits people on shows —
   * so the two rankings read are the films and the whole shows. Since 20261114000200 a
   * show ranks in its own pool (`tv_shows`) and is logged like a film, so a ranked or
   * logged show says so here exactly as its title page does (RC review, 2026-11-11).
   * The season pool is not read: a season is never a credit row.
   */
  const watchlist = useWatchlist(viewer.id);
  const watched = useWatched(viewer.id);
  const rankedMovies = useRankedCollection(viewer.id, 'movies');
  const rankedShows = useRankedCollection(viewer.id, 'tv_shows');

  const saved = useMemo(
    () => new Set((watchlist.data ?? []).map((entry) => entry.mediaItemId)),
    [watchlist.data],
  );
  const ranked = useMemo(
    () =>
      new Set(
        [...(rankedMovies.data ?? []), ...(rankedShows.data ?? [])].map(
          (entry) => entry.mediaItemId,
        ),
      ),
    [rankedMovies.data, rankedShows.data],
  );

  /**
   * **Cast and Crew are two lists, never one** (2026-09-13).
   *
   * Cast search sends somebody here to see what an actor has been in, and the page used to
   * answer with one list that mixed "Cobb" and "Executive Producer" — so a control labelled
   * Cast led to directing and producing credits presented as though they were parts. Now the
   * page opens on what they acted in, and the work behind the camera is the other half,
   * offered only when there is some.
   *
   * A title they both acted in and directed is in both halves: an acting credit carries its
   * crew jobs as `crewRole`, which is what keeps that film on the Crew side.
   */
  const credits = detail?.credits ?? [];
  // Appearances as themselves on talk shows and ceremonies are not parts. They are the Cast
  // half only for somebody who has nothing else there — a presenter, a reality-TV name —
  // whose page would otherwise say they had done nothing at all.
  const performances = credits.filter((credit) => credit.as === 'cast' && !credit.self);
  const castCredits = performances.length
    ? performances
    : credits.filter((credit) => credit.as === 'cast');
  const crewCredits = credits.filter((credit) => credit.crewRole !== null);
  const hasCast = castCredits.length > 0;
  const hasCrew = crewCredits.length > 0;
  // A chosen half is honoured only while it still has something in it: a refresh behind
  // the reader can empty one, and with the tabs then hidden there would be no way back.
  const chosen = role === 'cast' ? hasCast : role === 'crew' ? hasCrew : false;
  const shownRole: Role = chosen && role ? role : hasCast || !hasCrew ? 'cast' : 'crew';
  const roleCredits = shownRole === 'cast' ? castCredits : crewCredits;
  // Which of the cache's coverage records describes this list. A Cast half made of
  // appearances is the fallback above, and its caps were the appearances' own.
  const group: CoverageGroup =
    shownRole === 'crew' ? 'crew' : performances.length ? 'cast' : 'self';

  const counts = {
    movie: roleCredits.filter((credit) => credit.kind === 'movie').length,
    series: roleCredits.filter((credit) => credit.kind === 'series').length,
  };
  // Offered only where both kinds have something in them. A director with no
  // television is not asked to choose between Movies and TV — a filter with one
  // populated option is a control that can only ever narrow to what is already there.
  const filterable = counts.movie > 0 && counts.series > 0;
  // A filter left on a kind this half has none of (after a refresh, say) reads as All.
  const activeFilter: Filter = filterable ? filter : 'all';
  const filtered =
    activeFilter === 'all'
      ? roleCredits
      : roleCredits.filter((credit) => credit.kind === activeFilter);

  /**
   * The order, and what it can promise.
   *
   * Release date is the one axis (founder QA, 2026-11-12: Popular and Highest rated
   * (TMDB) are no longer offered), newest first until the reader flips it.
   */
  // Recomputed per render, deliberately: a list is at most about a hundred and thirty
  // credits, and memoising on arrays this component rebuilds every render would be a
  // cache that never hits.
  const axes = FILMOGRAPHY_AXES;
  const activeSort = coerceSortState(sort, axes);
  const sorted = sortFilmography(filtered, activeSort);
  const visible = sorted.slice(0, shown);

  // How many of this half TMDB had. A row cached before the halves were counted only knows
  // the combined figure, which is honest to show only when there is one half — and then
  // only as "credits", because it may count work of the other kind the old cap dropped.
  const halfTotal = shownRole === 'cast' ? detail?.castTotal : detail?.crewTotal;
  const roleTotal = halfTotal ?? (hasCast && hasCrew ? null : (detail?.creditTotal ?? null));
  const totalNoun =
    halfTotal === null || halfTotal === undefined
      ? 'credits'
      : shownRole === 'cast'
        ? 'acting credits'
        : 'crew credits';

  const coverage = sortCoverage(
    sorted,
    activeSort,
    detail?.coverage ?? null,
    group,
    activeFilter,
  );
  // A row cached before coverage existed is complete only if it says it kept everything.
  // Not for a Cast half made of appearances: its count is of performances, which says
  // nothing about how many appearances were kept.
  const uncertain =
    coverage.kind === 'unknown' &&
    !(group !== 'self' && roleTotal !== null && roleTotal <= roleCredits.length);
  const tailOnly = coverage.kind === 'partial' && coverage.tailOnly;
  const boundary = coverage.kind === 'partial' ? coverage.from : null;
  const tail = tailStart(sorted);

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

    // Additions only, and only on `ok` — the same rule as the other three bookmarks.
    if (present && result.outcome === 'ok') {
      track({ name: 'watchlist_added', props: { surface: 'title' } });
    }

    // Reconciled on an unknown outcome as well as on success — the same rule the other
    // three bookmark surfaces follow (`lib/write-outcome.ts`). Independent review 21e.
    if (mustReconcile(result)) {
      await Promise.all([
        // The watchlist and Queue Dragon, which counts it (`collection/invalidate.ts`).
        invalidateAfterWatchlistChange(queryClient, viewer.id),
        queryClient.invalidateQueries({ queryKey: queryKeys.title(credit.mediaItemId) }),
      ]);
    }

    if (result.outcome === 'failed') {
      Alert.alert('Could not update watchlist', result.message);
      return;
    }
  };

  // `claimed` counts as loading, and that is the point of carrying it up here: somebody
  // else's request is in flight, `usePerson` is polling for its result, and showing
  // "nothing here yet" in the meantime is what independent review 13 found two concurrent
  // readers stuck on.
  const loading = person.isPending || awaitingClaim || (fetching && !detail);

  return (
    <Screen includeBottomInset edges={[]}>
      {/* The route keeps the name for the iOS back label of whatever is pushed on top and
          for screen readers announcing the route; the bar itself is drawn by the page,
          exactly as on a title page or a list. */}
      <Stack.Screen options={{ title: name ?? '', headerShown: false }} />
      <TitleTopBar
        progress={top.ground}
        titleProgress={top.titleProgress}
        revealed={top.revealed && Boolean(name)}
        onBack={() => router.back()}
        title={name ?? ''}
      />

      <Animated.ScrollView
        contentContainerStyle={styles.content}
        onScroll={top.onScroll}
        scrollEventThrottle={16}
      >
        <TitleHero collapsedHeight={top.collapsedHero} topInset={top.topInset} />

        {loading ? (
          // The loading language, under the page's own top rather than a blank screen
          // (design-system.md §11b, "Every first load shows the loading language").
          <View testID="person-loading">
            <View style={[styles.identity, styles.identityPlaceholder]}>
              <View style={styles.portrait}>
                <View style={styles.portraitPlaceholder} />
              </View>
            </View>
            <SkeletonRow count={6} />
          </View>
        ) : person.isError ? (
          <View style={styles.state}>
            <EmptyState
              kind="couldNotLoad"
              title="Could not load this person"
              body="Check your connection and try again."
              action={{ label: 'Try again', onPress: tryAgain }}
            />
          </View>
        ) : !detail ? (
          // Reached when the provider had nothing for this id, or the fetch failed, or
          // somebody else's claim lapsed without an answer. Honest about which it
          // cannot be: they look the same from here. `tryAgain` clears the one-attempt
          // guard, so this control genuinely asks again rather than re-reading a cache
          // that has not changed.
          <View style={styles.state}>
            <EmptyState
              kind="nothingYet"
              title="Nothing here yet"
              body="We could not load this person's work. Try again in a moment."
              action={{ label: 'Try again', onPress: tryAgain }}
            />
          </View>
        ) : (
          <>
            <View
              style={styles.identity}
              onLayout={top.onIdentityLayout}
              testID="person-identity"
            >
              {/* The portrait straddles the band, as a poster does on a title page with
                  no artwork, ringed in Paper so its edge reads against the band. */}
              <View style={styles.portrait}>
                <Avatar size="lg" uri={profileUri(detail.profilePath)} name={detail.name} />
              </View>
              <Text variant="title1" accessibilityRole="header" testID="person-name">
                {detail.name}
              </Text>
              {/* Known-for and the life dates, on one line, because each on its own is
                  a fragment and together they place somebody. Absent entirely rather
                  than shown as a dash: TMDB genuinely does not have a birthday for
                  everybody, and an em dash where a date goes reads as a failure. */}
              {metaLine(detail) ? (
                <Text variant="footnote" tone="secondary" testID="person-meta">
                  {metaLine(detail)}
                </Text>
              ) : null}
            </View>

            {detail.biography ? (
              <Biography text={detail.biography} truncated={detail.biographyTruncated} />
            ) : null}

            <View style={styles.section}>
              {/* The content header row (design-system.md §8): the section's name on the
                  left and the one control that acts on the list beneath it on the right.
                  Not "In your catalogue", and since 2026-11-11 not "Known for" either:
                  this is their work, all of it that was kept, in an order the reader can
                  choose. */}
              <ContentToolbar
                edgeInset={0}
                testID="filmography-header"
                title={
                  <Text
                    variant="sectionHeader"
                    tone="action"
                    accessibilityRole="header"
                    accessibilityLabel="Filmography"
                  >
                    Filmography
                  </Text>
                }
              >
                {roleCredits.length > 1 ? (
                  <SortChip
                    axes={axes}
                    value={activeSort}
                    onPress={() => setSortOpen((open) => !open)}
                  />
                ) : null}
              </ContentToolbar>

              {sortOpen && roleCredits.length > 1 ? (
                <View testID="filmography-sort-menu">
                  <SortMenu
                    axes={axes}
                    value={activeSort}
                    onChange={(next) => {
                      setSort(next);
                      // A different order: its first page. Keeping the count would drop
                      // the reader into the middle of an order they have not seen the start of.
                      setShown(PAGE);
                    }}
                    onClose={() => setSortOpen(false)}
                  />
                </View>
              ) : null}

              {hasCast && hasCrew ? (
                <View style={styles.tabs}>
                  <SegmentedTabs
                    options={ROLE_TABS}
                    value={shownRole}
                    accessibilityLabel="Cast or crew"
                    onChange={(next) => {
                      setRole(next);
                      // A different list: its first page, unfiltered. A Movies filter kept
                      // across the switch could narrow the other half to nothing and read
                      // as a person with no work there. The order is kept: it is the
                      // reader's question, and it means the same thing in either half.
                      setFilter('all');
                      setShown(PAGE);
                    }}
                  />
                </View>
              ) : null}

              {filterable ? (
                <View style={styles.tabs}>
                  <SegmentedTabs
                    options={KIND_TABS}
                    value={activeFilter}
                    accessibilityLabel="Movies or TV"
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

              {/* A row cached before coverage was recorded: the order is right for what
                  is here, and the page says that what is here may not be everything. */}
              {uncertain ? (
                <ListNote testID="sort-scope-note">
                  {roleTotal !== null
                    ? `Sorted within the ${roleCredits.length} ${totalNoun} kept here, of ${roleTotal} TMDB lists.`
                    : 'Sorted within the credits kept here, which may not be all of their work.'}
                </ListNote>
              ) : null}

              <View style={styles.list}>
                {visible.length ? (
                  visible.map((credit, index) => (
                    <Fragment key={credit.mediaItemId}>
                      {index === boundary ? (
                        <ListNote testID="coverage-note">
                          {boundaryNote(activeSort, true, tailOnly)}
                        </ListNote>
                      ) : null}
                      {index === tail ? (
                        <ListNote testID="tail-note" quiet>
                          No release date yet
                        </ListNote>
                      ) : null}
                      <TitleRow
                        title={credit.title}
                        year={credit.year}
                        posterUri={posterUri(credit.posterPath)}
                        // Their character on the Cast side and their jobs on the Crew side,
                        // so a film they did both on never shows "Director" under Cast.
                        secondary={shownRole === 'cast' ? credit.role : credit.crewRole}
                        tertiary={stateLabel(credit, { saved, ranked, watched: watched.data })}
                        divided={
                          index < visible.length - 1 &&
                          index + 1 !== boundary &&
                          index + 1 !== tail
                        }
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
                    </Fragment>
                  ))
                ) : (
                  <EmptyState
                    kind="nothingYet"
                    compact
                    title="Nothing here"
                    body="TMDB lists no credits of this kind for them."
                  />
                )}

                {/* Everything kept is vouched for and only the tail is missing: said once
                    the list has reached its end, which is where the missing credits go. */}
                {boundary !== null &&
                boundary === sorted.length &&
                visible.length === sorted.length ? (
                  <ListNote testID="coverage-note">
                    {boundaryNote(activeSort, false, tailOnly)}
                  </ListNote>
                ) : null}
              </View>

              {sorted.length > visible.length ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Show more of ${detail.name}'s work`}
                  onPress={() => setShown((count) => count + PAGE)}
                  style={({ pressed }) => [styles.more, pressed && styles.pressed]}
                >
                  <Text variant="callout" tone="action">
                    See more
                  </Text>
                </Pressable>
              ) : null}

              {/* What is not being shown, said rather than implied. The adapter keeps the
                  most popular sixty acting and thirty crew credits, plus each half's
                  newest, oldest and best rated; somebody with three hundred should not be
                  presented as somebody with sixty. */}
              {roleTotal !== null && roleTotal > roleCredits.length ? (
                <View style={styles.caption}>
                  <Text variant="caption" tone="tertiary">
                    {`Showing ${roleCredits.length} of ${roleTotal} ${totalNoun} TMDB lists.`}
                  </Text>
                </View>
              ) : null}
            </View>

            <View style={styles.footer}>
              <Text variant="caption" tone="tertiary">
                Metadata from TMDB
              </Text>
            </View>
          </>
        )}
      </Animated.ScrollView>
    </Screen>
  );
}

/** How many credits a page shows before "See more". */
const PAGE = 12;

/** How far the compact name takes to arrive once the large one reaches the bar. */
const TITLE_FADE = 24;

/**
 * The person page's top bar arithmetic.
 *
 * Two values, because the page has two edges to cross. **The ground** arrives over the
 * collapsed band, exactly as `useHeroReveal` does it for a title or a list without
 * artwork, so the bar is Paper by the time the band has gone. **The name** arrives only
 * once the large name has passed under the bar — measured off the identity block by
 * `useDetailHeader`, the rule every detail page follows — because here the name sits under
 * a portrait that hangs below the band, and fading it in with the ground would put it in
 * the bar while the large one is still on screen.
 */
function usePersonTopBar() {
  const insets = useSafeAreaInsets();
  const header = useDetailHeader();
  const [scrollY] = useState(() => new Animated.Value(0));
  const [identityBottom, setIdentityBottom] = useState<number | null>(null);

  const barHeight = insets.top + NAV_BAR_HEIGHT;
  const ground = scrollY.interpolate({
    inputRange: [0, HERO_COLLAPSED_BAND],
    outputRange: [0, 1],
    extrapolate: 'clamp',
  });
  // Until the identity has been measured there is no name to be past, so the fade sits
  // out of reach rather than at zero, where any scroll would complete it.
  const titleEnd = identityBottom === null ? 1e9 : Math.max(identityBottom - barHeight, 1);
  // From the moment the large name has fully passed under the bar, never before it, so
  // the two are never both readable at once.
  const titleProgress = scrollY.interpolate({
    inputRange: [titleEnd, titleEnd + TITLE_FADE],
    outputRange: [0, 1],
    extrapolate: 'clamp',
  });

  const onScroll = Animated.event([{ nativeEvent: { contentOffset: { y: scrollY } } }], {
    useNativeDriver: true,
    listener: header.onScroll,
  });

  const onIdentityLayout = (event: LayoutChangeEvent) => {
    const { y, height } = event.nativeEvent.layout;
    setIdentityBottom(y + height);
    header.onIdentityLayout(event);
  };

  return {
    ground,
    titleProgress,
    revealed: header.revealed,
    onScroll,
    onIdentityLayout,
    collapsedHero: barHeight + HERO_COLLAPSED_BAND,
    topInset: insets.top,
  };
}

/**
 * What a sorted list says at the row where it stops being complete.
 *
 * Phrased about the credits rather than about the cache: the reader's question is whether
 * this is everything from here on, and the answer is that some of what TMDB lists of that
 * kind is not here.
 */
function boundaryNote(sort: FilmographySort, inline: boolean, tailOnly: boolean) {
  const what = tailOnly
    ? 'credits with no release date'
    : sort.direction === 'desc'
      ? 'older credits'
      : 'later credits';
  return inline
    ? `From here on, not every one of their ${what} is listed.`
    : `Not every one of their ${what} is listed.`;
}

/** A line of small print between rows of the list, at the gutter. */
function ListNote({
  children,
  quiet = false,
  testID,
}: {
  children: string;
  quiet?: boolean;
  testID?: string;
}) {
  return (
    <View style={[styles.note, quiet && styles.noteQuiet]} testID={testID}>
      <Text variant={quiet ? 'caption' : 'footnote'} tone={quiet ? 'tertiary' : 'secondary'}>
        {children}
      </Text>
    </View>
  );
}

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

/** Lines the biography takes before `more`. */
const BIOGRAPHY_LINES = 3;

/**
 * The biography, three lines until it is opened, with `… more` on the third.
 *
 * `ClampedText`, the title page's synopsis treatment, because it is the same kind of block
 * doing the same job — and because the previous hand-rolled version put `more` on a line
 * of its own, which is the defect that component was built to fix.
 *
 * **What it promises when opened** (audit, 2026-11-11). The adapter keeps 1,200
 * characters of TMDB's biography (`MAX_BIOGRAPHY_CHARS`), cut mid-word. Opening it used to
 * show those characters and an ellipsis, under a control whose only word was `more` — so
 * the reader was promised the rest and given a fragment. Now a shortened biography ends at
 * its last whole sentence (or word, if a sentence would lose too much), and once it is
 * fully on screen it says plainly that it was shortened and where the rest is.
 */
function Biography({ text, truncated }: { text: string; truncated: boolean }) {
  return (
    <ClampedText
      text={truncated ? shortened(text) : text}
      clamp={BIOGRAPHY_LINES}
      testIDPrefix="biography"
      expandLabel="Expand biography"
      collapseLabel="Collapse biography"
      completeFooter={
        truncated ? (
          <Text
            variant="footnote"
            tone="tertiary"
            testID="biography-shortened"
            style={styles.shortened}
          >
            Shortened. The full biography is on TMDB.
          </Text>
        ) : undefined
      }
      style={styles.block}
    />
  );
}

/**
 * What the reader has already done with this title, in one word or none.
 *
 * One word, not three: a row carrying "Saved · Ranked · Watched" is a row about the
 * reader rather than about the film. Ranked wins over watched because it is the
 * stronger statement and implies it. A series says either only about the *show itself*
 * (ranked in `tv_shows`, or logged as a show, 20261114000200): its `user_media` row is
 * the show's own, so a reader who logged only seasons is not told they watched it.
 */
function stateLabel(
  credit: PersonCredit,
  state: { saved: Set<string>; ranked: Set<string>; watched: Set<string> | undefined },
) {
  if (credit.kind === 'movie' || credit.kind === 'series') {
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
      {/* Filled Maroon when saved, outlined and secondary otherwise — Search's pair,
          which is the app's one watchlist treatment. This drew Maroon in both states,
          so an unsaved bookmark on a person page read as already selected while the
          same control on Search did not (pre-GTM audit, 2026-09-07). */}
      <Ionicons
        name={saved ? 'bookmark' : 'bookmark-outline'}
        size={theme.layout.icon.md}
        color={saved ? theme.semantic.action : theme.text.secondary}
      />
    </Pressable>
  );
}

/** The portrait's diameter, which is also how far it hangs into the band. */
const PORTRAIT = theme.layout.avatar.lg;
/** The Paper ring around it. */
const RING = 3;

const styles = StyleSheet.create({
  content: { paddingBottom: theme.space[10] },
  /**
   * Who they are: portrait, name, one line of facts.
   *
   * Pulled up by half the portrait so it straddles the band. The seams inside are the
   * compact-related interval (`space[1]`–`space[2]`): this is one statement, not three.
   */
  identity: {
    paddingHorizontal: theme.layout.gutter,
    marginTop: -(PORTRAIT / 2 + RING),
    gap: theme.space[1],
  },
  identityPlaceholder: { paddingBottom: theme.space[4] },
  portrait: {
    alignSelf: 'flex-start',
    borderRadius: theme.radius.full,
    borderWidth: RING,
    borderColor: theme.surface.base,
    backgroundColor: theme.surface.base,
    marginBottom: theme.space[2],
  },
  portraitPlaceholder: {
    width: PORTRAIT,
    height: PORTRAIT,
    borderRadius: theme.radius.full,
    backgroundColor: theme.surface.sunken,
  },
  // The biography sits under the facts as part of the identity's answer: 12, not a section seam.
  block: {
    paddingHorizontal: theme.layout.gutter,
    paddingTop: theme.space[3],
  },
  // Its own gutter: it sits after the biography's press target, not inside its padding.
  shortened: { paddingTop: theme.space[2], paddingHorizontal: theme.layout.gutter },
  // Identity → the work: a major section seam (design-system.md §5, `space[6]`).
  section: { paddingTop: theme.space[6] },
  // Header row → its controls: compact, related (`space[2]`); the last control → the list: 12.
  tabs: { paddingTop: theme.space[2] },
  list: { paddingTop: theme.space[2] },
  note: {
    paddingHorizontal: theme.layout.gutter,
    paddingTop: theme.space[3],
    paddingBottom: theme.space[2],
    borderTopWidth: StyleSheet.hairlineWidth * 2,
    borderTopColor: theme.border.hairline,
    marginTop: theme.space[1],
  },
  noteQuiet: { borderTopWidth: 0, paddingTop: theme.space[2], paddingBottom: theme.space[1] },
  more: {
    minHeight: theme.layout.minTapTarget,
    justifyContent: 'center',
    paddingHorizontal: theme.layout.gutter,
    marginTop: theme.space[1],
    alignSelf: 'flex-start',
  },
  caption: { paddingHorizontal: theme.layout.gutter, paddingTop: theme.space[2] },
  state: { paddingTop: theme.space[6] },
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
