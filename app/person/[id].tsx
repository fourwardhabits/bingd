import { useQueryClient } from '@tanstack/react-query';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { Fragment, useMemo, useState } from 'react';
import {
  Alert,
  Animated,
  Pressable,
  StyleSheet,
  View,
  useWindowDimensions,
  type LayoutChangeEvent,
  type NativeSyntheticEvent,
  type TextLayoutEventData,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useCurrentProfile } from '@/features/auth';
import { useCelebrationHandoff } from '@/features/awards/celebration-queue';
import { today } from '@/features/collection/dates';
import { LogSheet, type LoggableTitle, type PostRank } from '@/features/collection/LogSheet';
import { rankingStateOf, resumeSubject } from '@/features/collection/ranking-state';
import { TitleRowActions } from '@/features/collection/TitleRowActions';
import {
  useLoggedCollection,
  useRankedCollection,
  useWatchlist,
} from '@/features/collection/use-collection';
import { useWatched } from '@/features/collection/use-watched';
import { useWatchlistToggle } from '@/features/collection/use-watchlist-toggle';
import { mustReconcile } from '@/features/collection/writes';
import {
  INITIAL_FILMOGRAPHY_SORT,
  filmographyAxes,
  sortCoverage,
  sortFilmography,
  tailStart,
  type CoverageGroup,
  type FilmographySort,
} from '@/features/person/filmography';
import { pickPersonBackdrop } from '@/features/person/backdrop';
import { shortened } from '@/features/person/biography';
import { birthLine } from '@/features/person/identity';
import { usePerson, usePersonFetch, type PersonCredit } from '@/features/person/use-person';
import { RankingSheet, type RankingSubject } from '@/features/ranking/RankingSheet';
import { NAV_BAR_HEIGHT, TitleTopBar } from '@/features/title/TitleTopBar';
import { HERO_COLLAPSED_BAND, REVEAL_WINDOW } from '@/features/title/use-hero-reveal';
import { backdropUri, posterUri, profileUri } from '@/lib/images';
import { queryKeys } from '@/lib/query';
import {
  Avatar,
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
 * - **Honest sorting.** A date or rating sort over a capped filmography says where it
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

  const hero = usePersonHero(id ?? null, detail?.credits ?? null);
  const top = usePersonTopBar(hero !== null);
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
   * The axes are decided by the half, not the filter, so the rating axis does not come
   * and go as Movies and TV are switched. A chosen axis this half cannot offer — the
   * rating, on a half with no TMDB scores — falls back to Popular for as long as it is
   * shown, without forgetting the reader's choice for the half that can.
   */
  // Recomputed per render, deliberately: a list is at most about a hundred and thirty
  // credits, and memoising on arrays this component rebuilds every render would be a
  // cache that never hits.
  const axes = filmographyAxes(roleCredits);
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
  const tail = tailStart(sorted, activeSort);

  /**
   * **Search's watchlist write, shared** (founder spec §6, 2026-11-13). The page had its
   * own copy, guarded by a state value — so two taps inside one frame both reached
   * `set_watchlist` before the first re-render drew the bookmark busy. `useWatchlistToggle`
   * is the hook Search and the list rows use, and its guard is a ref, which answers
   * synchronously: one write per tap, whichever row. Analytics, reconciliation on an
   * unknown outcome and the failure alert are unchanged; the title's own cache is still
   * invalidated here, as it was.
   */
  const watchlistToggle = useWatchlistToggle(viewer.id, 'title');
  const toggleWatchlist = async (credit: PersonCredit) => {
    const result = await watchlistToggle.toggle(credit.mediaItemId);
    if (!result) return;
    if (mustReconcile(result)) {
      await queryClient.invalidateQueries({ queryKey: queryKeys.title(credit.mediaItemId) });
    }
    if (result.outcome === 'failed') {
      Alert.alert('Could not update watchlist', result.message);
    }
  };

  /**
   * **+ Rank from a filmography row: Search's path, not a new one** (founder spec §6).
   *
   * The same `LogSheet` → `RankingSheet` pair Search mounts, wired the same way: `+` opens
   * "How was it?", the band hands over to the comparisons, a finished placement comes back
   * to the sheet with its score. An unfinished placement resumes its own session instead
   * of starting again, so a reader cannot leave a second partial ranking of the same
   * title. A ranked row draws no `+` at all (below), so there is no second entry point
   * into a ranking that already exists.
   */
  const celebrate = useCelebrationHandoff();
  const [logging, setLogging] = useState<LoggableTitle | null>(null);
  const [ranking, setRanking] = useState<RankingSubject | null>(null);
  const [placement, setPlacement] = useState<PostRank | null>(null);
  const [rankedTitle, setRankedTitle] = useState<LoggableTitle | null>(null);
  const logged = useLoggedCollection(viewer.id);
  const unfinished = useMemo(
    () =>
      new Map(
        (logged.data?.entries ?? [])
          .filter(
            (entry) =>
              rankingStateOf({ ranked: ranked.has(entry.mediaItemId), bucket: entry.bucket }) ===
              'unfinished',
          )
          .map((entry) => [entry.mediaItemId, entry.bucket as string] as const),
      ),
    [logged.data, ranked],
  );
  /**
   * Whether the reader's rankings have been read. Until they have, the page cannot tell a
   * ranked title from an unranked one, so it offers no `+` at all rather than a `+` that
   * might resume or restart a ranking that already exists (independent review). Only the
   * `+` waits on this; the bookmark waits on the watchlist alone, as before.
   */
  const rankingsKnown = rankedMovies.isSuccess && rankedShows.isSuccess && logged.isSuccess;
  const openRank = (credit: PersonCredit) => {
    // One flow at a time: a second tap while a sheet is up opens nothing new.
    if (logging || ranking || !rankingsKnown) return;
    const title: LoggableTitle = {
      id: credit.mediaItemId,
      title: credit.title,
      year: credit.year,
      posterUri: posterUri(credit.posterPath, 'card'),
      kind: credit.kind,
    };
    const bucket = unfinished.get(credit.mediaItemId);
    const resume = bucket ? resumeSubject(title, bucket) : null;
    if (resume) {
      setRanking(resume);
      setRankedTitle(title);
      setPlacement(null);
      return;
    }
    setLogging(title);
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
        {/* One of their own films behind them, chosen from credits already on the page
            (`pickPersonBackdrop`), or the branded band when none has a backdrop — and
            while the credits load, so the page never draws a broken image. */}
        <TitleHero uri={hero} collapsedHeight={top.collapsedHero} topInset={top.topInset} />

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
              {/* **At most `Born 1959 · Japan`** (founder spec §6, 2026-11-13), where it was
                  `Acting · born 1974 · Los Angeles, California, USA`: the hierarchy is
                  name → biography → filmography, and this line is the one piece of
                  context kept between the first two. Absent entirely rather than a dash
                  when TMDB has neither fact (`birthLine`). */}
              {birthLine(detail) ? (
                <Text variant="footnote" tone="tertiary" testID="person-meta">
                  {birthLine(detail)}
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
              {/**
               * **The filmography, modernised** (founder spec §6, 2026-11-13).
               *
               *     FILMOGRAPHY                                  ← the large section heading
               *     [      Cast      |      Crew      ]           ← which work: navigation
               *     All  Movies  TV                ⇅ Popular     ← narrow it, and order it
               *
               * Cast / Crew is "take me to this content", so it is the segmented `nav`
               * control across the gutters; All / Movies / TV narrows what is shown, so it
               * stays the quiet underline tabs, on one line with the sort chip — the
               * filters and the order together, where the Collection tab puts them. The
               * three orders (Popular, Release date, Highest rated) and every note about
               * what TMDB kept are unchanged.
               */}
              <View style={styles.filmographyHead} testID="filmography-header">
                <Text
                  variant="sectionHeaderLarge"
                  tone="action"
                  accessibilityRole="header"
                  accessibilityLabel="Filmography"
                >
                  Filmography
                </Text>
              </View>

              {hasCast && hasCrew ? (
                <View style={styles.roleTabs}>
                  <SegmentedTabs
                    variant="nav"
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

              {filterable || roleCredits.length > 1 ? (
                <View style={styles.controls} testID="filmography-controls">
                  <View style={styles.kindTabs}>
                    {filterable ? (
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
                    ) : null}
                  </View>
                  {roleCredits.length > 1 ? (
                    <SortChip
                      axes={axes}
                      value={activeSort}
                      onPress={() => setSortOpen((open) => !open)}
                    />
                  ) : null}
                </View>
              ) : null}

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

              {/* A row cached before coverage was recorded: the order is right for what
                  is here, and the page says that what is here may not be everything. */}
              {uncertain && activeSort.axis !== 'popular' ? (
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
                          {activeSort.axis === 'released'
                            ? 'No release date yet'
                            : 'Too few TMDB ratings to rank'}
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
                        /**
                         * **+ Rank and the bookmark, Search's own row controls**
                         * (`TitleRowActions`, founder spec §6). A title the reader has
                         * already ranked draws neither — its "Ranked" line says so, and a
                         * `+` there would be a second way into a ranking that exists —
                         * and draws no score badge either: no badges on these rows in
                         * this pass. The bookmark shows the watchlist as it is, and hides
                         * until the watchlist has been read rather than guessing.
                         */
                        trailing={
                          ranked.has(credit.mediaItemId) ? undefined : (
                            <TitleRowActions
                              name={credit.title}
                              kind={credit.kind}
                              score={null}
                              // No `+` until the reader's rankings are read; the bookmark
                              // does not wait on them (independent review).
                              rankable={rankingsKnown}
                              saved={watchlistToggle.isSaved(credit.mediaItemId)}
                              busy={watchlistToggle.busy === credit.mediaItemId}
                              onRank={() => openRank(credit)}
                              onToggleWatchlist={() => void toggleWatchlist(credit)}
                            />
                          )
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

      {/* Search's pair, wired exactly as Search wires them (`app/(tabs)/log.tsx`). */}
      <LogSheet
        title={logging}
        onClose={() => {
          setLogging(null);
          setPlacement(null);
          celebrate();
        }}
        surface="title"
        postRank={placement}
        onDone={() => {
          setLogging(null);
          setPlacement(null);
          celebrate();
        }}
        onRank={(bucket, mode) => {
          if (!logging) return;
          // The log sheet closes as the comparison opens: one sheet at a time.
          setRanking({
            id: logging.id,
            title: logging.title,
            bucket,
            posterUri: logging.posterUri,
            kind: logging.kind,
            mode,
          });
          setRankedTitle(logging);
          setLogging(null);
        }}
      />
      <RankingSheet
        subject={ranking}
        onClose={() => setRanking(null)}
        onFinishLog={(result) => {
          setRanking(null);
          if (!rankedTitle) return;
          setPlacement(result);
          setLogging(rankedTitle);
        }}
        surface="title"
      />
    </Screen>
  );
}

/** How many credits a page shows before "See more". */
const PAGE = 12;

/** How far the compact name takes to arrive once the large one reaches the bar. */
const TITLE_FADE = 24;

/**
 * **The hero's artwork: a backdrop from their latest released work** (founder QA P1-9).
 *
 * `pickPersonBackdrop` holds the rule and its tests. Nothing is fetched for it: the
 * backdrop is a column of the `media_items` rows `usePerson` already reads.
 *
 * **Chosen once per person, then kept.** The first answer for this person is pinned for
 * the life of the page, so a background refresh of a stale filmography — or a re-render
 * with a rebuilt credits array — never swaps the picture under the reader. Until there is
 * an answer (credits loading, or none with a backdrop) the hero is the branded band, and
 * `TitleHero`'s image fades in over the band's own Parchment when one arrives.
 */
function usePersonHero(personId: string | null, credits: PersonCredit[] | null) {
  const picked = useMemo(
    () => (credits ? (pickPersonBackdrop(credits, today())?.backdropPath ?? null) : null),
    [credits],
  );
  const [pinned, setPinned] = useState<{ personId: string | null; path: string } | null>(null);
  const held = pinned?.personId === personId ? pinned.path : null;
  // Set during render, React's pattern for state derived from a change: one extra render,
  // no effect, and no frame drawn with the old person's picture.
  if (held === null && picked !== null) setPinned({ personId, path: picked });
  return backdropUri(held ?? picked, 'hero');
}

/**
 * The person page's top bar arithmetic.
 *
 * Two values, because the page has two edges to cross. **The ground** arrives over the
 * last stretch of the hero, exactly as `useHeroReveal` does it for a title or a list —
 * over the collapsed band when there is no artwork (from the top, as before), and over the
 * last `REVEAL_WINDOW` of the 16:9 backdrop when there is — so the bar is Paper by the time
 * the hero has gone, and never lays Paper over a picture that is still on screen.
 *
 * **The name** arrives only once the large name has passed under the bar — measured off
 * the identity block by `useDetailHeader`, the rule every detail page follows — because
 * here the name sits under a portrait that hangs below the hero, and fading it in with the
 * ground would put it in the bar while the large one is still on screen.
 */
function usePersonTopBar(hasArtwork: boolean) {
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const header = useDetailHeader();
  const [scrollY] = useState(() => new Animated.Value(0));
  const [identityBottom, setIdentityBottom] = useState<number | null>(null);

  const barHeight = insets.top + NAV_BAR_HEIGHT;
  // `useHeroReveal`'s arithmetic. With no artwork it is [0, HERO_COLLAPSED_BAND] exactly,
  // the range this page has always used.
  const groundEnd = hasArtwork
    ? Math.max(width / theme.layout.aspect.backdrop - barHeight, 2)
    : HERO_COLLAPSED_BAND;
  const groundStart = Math.max(groundEnd - REVEAL_WINDOW, 0);
  const ground = scrollY.interpolate({
    inputRange: [groundStart, groundEnd],
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
    ? sort.axis === 'rating'
      ? 'credits with too few TMDB ratings'
      : 'credits with no release date'
    : sort.axis === 'rating'
      ? 'lower-rated credits'
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

/** Lines the biography takes before `more`. */
const BIOGRAPHY_LINES = 3;

/**
 * **A long biography collapses, with a clear More / Less** (founder spec §6, 2026-11-13).
 *
 * `ClampedText`, which this used, puts an inline "more" on the last line and deliberately
 * draws no "less" once open. The founder asked for an explicit pair, so the biography
 * clamps to {@link BIOGRAPHY_LINES} and a separate More / Less under it opens and closes
 * it. The toggle is drawn only for a biography that is actually longer than the clamp: an
 * invisible, unclamped copy measures its lines (the technique `ClampedText` uses), and
 * until that answer arrives a length estimate stands in, so a short biography never shows
 * a control that does nothing. A cut biography still says so once it is open, outside the
 * toggle so a screen reader reaches it.
 */
function Biography({ text, truncated }: { text: string; truncated: boolean }) {
  const body = truncated ? shortened(text) : text;
  const [measured, setMeasured] = useState<{ body: string; lines: number } | null>(null);
  const [open, setOpen] = useState(false);
  const lines = measured?.body === body ? measured.lines : null;
  const long = lines !== null ? lines > BIOGRAPHY_LINES : body.length > BIOGRAPHY_ESTIMATE;

  return (
    <View style={styles.block} testID="biography">
      <View>
        <View
          style={styles.measure}
          pointerEvents="none"
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
        >
          <Text
            variant="body"
            onTextLayout={(event: NativeSyntheticEvent<TextLayoutEventData>) =>
              {
                const count = event.nativeEvent.lines.length;
                // Unchanged answers keep the same state, so a layout pass that repeats
                // itself does not re-render the biography (independent review).
                setMeasured((was) =>
                  was?.body === body && was.lines === count ? was : { body, lines: count },
                );
              }
            }
          >
            {body}
          </Text>
        </View>
        <Text
          variant="body"
          numberOfLines={open || !long ? undefined : BIOGRAPHY_LINES}
          testID="biography-text"
        >
          {body}
        </Text>
      </View>
      {long ? (
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded: open }}
          accessibilityLabel={open ? 'Collapse biography' : 'Expand biography'}
          onPress={() => setOpen((was) => !was)}
          style={({ pressed }) => [styles.bioToggle, pressed && styles.pressed]}
          testID="biography-toggle"
        >
          <Text variant="footnote" tone="action">
            {open ? 'Less' : 'More'}
          </Text>
        </Pressable>
      ) : null}
      {/* Once it is all on screen — opened, or short enough never to need opening. */}
      {truncated && (open || !long) ? (
        <Text variant="footnote" tone="tertiary" testID="biography-shortened" style={styles.shortened}>
          Shortened. The full biography is on TMDB.
        </Text>
      ) : null}
    </View>
  );
}

/** Before the measure answers: about three lines of body text on a narrow phone. */
const BIOGRAPHY_ESTIMATE = 160;

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
  // The biography sits under the name as part of the identity's answer: 12, not a section seam.
  block: {
    paddingHorizontal: theme.layout.gutter,
    paddingTop: theme.space[3],
  },
  // Off the flow and invisible: the unclamped copy that counts the biography's lines.
  measure: { position: 'absolute', left: 0, right: 0, opacity: 0 },
  // More / Less: a 44pt target with the word on the gutter.
  bioToggle: {
    minHeight: theme.layout.minTapTarget,
    minWidth: theme.layout.minTapTarget,
    justifyContent: 'center',
    alignSelf: 'flex-start',
  },
  shortened: { paddingTop: theme.space[1] },
  // Identity → the work: a major section seam (design-system.md §5, `space[6]`).
  section: { paddingTop: theme.space[6] },
  // The heading on the gutter, at the large section-heading size.
  filmographyHead: {
    minHeight: theme.layout.minTapTarget,
    justifyContent: 'center',
    paddingHorizontal: theme.layout.gutter,
  },
  // Cast | Crew across the gutters; then the filters and the order on one line.
  roleTabs: { paddingTop: theme.space[1] },
  controls: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    columnGap: theme.space[2],
    paddingTop: theme.space[2],
    paddingRight: theme.layout.gutter,
  },
  // Takes what the sort chip leaves; its own row scrolls sideways if it ever has to.
  kindTabs: { flex: 1, minWidth: 0 },
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
  pressed: { opacity: 0.7 },
  footer: {
    paddingHorizontal: theme.layout.gutter,
    paddingTop: theme.space[6],
  },
});
