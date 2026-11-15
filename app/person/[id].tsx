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
import { useMyScores } from '@/features/collection/use-score';
import { useWatched } from '@/features/collection/use-watched';
import { useWatchlistToggle } from '@/features/collection/use-watchlist-toggle';
import type { Decade } from '@/features/collection/filters';
import { mustReconcile } from '@/features/collection/writes';
import {
  INITIAL_FILMOGRAPHY_SORT,
  filmographyAxes,
  filmographyDecades,
  filterByDecades,
  sortCoverage,
  sortFilmography,
  tailStart,
  type CoverageGroup,
  type FilmographySort,
} from '@/features/person/filmography';
import { FilmographyFilterSheet } from '@/features/person/FilmographyFilterSheet';
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
  BrowseControlsRow,
  EmptyState,
  FilterIconButton,
  MediumSelector,
  Screen,
  SegmentedTabs,
  SkeletonRow,
  Text,
  TitleHero,
  TitleRow,
  useDetailHeader,
  type MediumSelectorOption,
} from '@/ui/components';
import { coerceSortState, filterSortSpoken } from '@/ui/sort';
import { theme } from '@/ui/tokens';

/** Which kind of work is listed. There is no All since FU1113-C: one medium at a time. */
type FilmMedium = 'movie' | 'series';
type Role = 'cast' | 'crew';

const ROLE_TABS = [
  { id: 'cast' as const, label: 'Cast' },
  { id: 'crew' as const, label: 'Crew' },
];

const MEDIUM_CHOICES: readonly MediumSelectorOption<FilmMedium>[] = [
  { id: 'movie', label: 'Movies' },
  { id: 'series', label: 'TV' },
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
 *   be ordered — `filmography.ts` — from the Filters & Sort sheet behind the section's
 *   filter icon (FU1113-C; it was a sort chip in the header row until then).
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

  // Null until the reader chooses, so the page opens on whichever half they have work in.
  const [role, setRole] = useState<Role | null>(null);
  /**
   * Movies or TV, null until the reader chooses (FU1113-C). Per visit and never stored: the
   * page opens on Movies when the half on screen has films, and on TV otherwise.
   */
  const [medium, setMedium] = useState<FilmMedium | null>(null);
  /** The Decade filter, the one a credit supports (`filmographyDecades`). */
  const [decades, setDecades] = useState<Decade[]>([]);
  const [sort, setSort] = useState<FilmographySort>(INITIAL_FILMOGRAPHY_SORT);
  const [filtering, setFiltering] = useState(false);
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
  /**
   * The reader's score per title: **Search's own read** (`useMyScores`, `app/(tabs)/log.tsx`),
   * so a filmography row draws exactly the score circle Search draws for the same title.
   */
  const myScores = useMyScores(viewer.id);

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

  const movieCount = roleCredits.filter((credit) => credit.kind === 'movie').length;
  /**
   * **One medium at a time, Movies first** (FU1113-C, replacing All / Movies / TV). The
   * reader's choice is kept for the visit; until there is one, Movies when this half has
   * any films and TV otherwise — so a television actor opens on their television, and a
   * director with no TV is never shown an empty Movies list by default.
   */
  const shownMedium: FilmMedium = medium ?? (movieCount > 0 ? 'movie' : 'series');
  const mediumCredits = roleCredits.filter((credit) => credit.kind === shownMedium);
  const decadeOptions = filmographyDecades(mediumCredits);
  const filtered = filterByDecades(mediumCredits, decades);

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

  // Per credit, so it stays true of a decade-filtered list: a row is vouched for by its own
  // date or score, whichever other rows are on screen.
  const coverage = sortCoverage(
    sorted,
    activeSort,
    detail?.coverage ?? null,
    group,
    shownMedium,
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
   * title. A ranked row draws no `+` at all (below; only its bookmark), so there is no
   * second entry point into a ranking that already exists.
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
  const rankingsKnown =
    rankedMovies.isSuccess && rankedShows.isSuccess && logged.isSuccess && myScores.isSuccess;
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

  /** A credit row's trailing controls: `TitleRowActions` with Search's inputs. */
  const rowActions = (credit: PersonCredit) => {
    const mine = myScores.data?.get(credit.mediaItemId) ?? null;
    // Ranked by either read: the score circle's own, or the rankings behind "Ranked".
    const isRanked = mine !== null || ranked.has(credit.mediaItemId);
    return (
      <TitleRowActions
        name={credit.title}
        kind={credit.kind}
        score={mine}
        // Never a `+` on a ranked title, and none until the rankings are read.
        rankable={!isRanked && rankingsKnown}
        // A ranked row is its score alone, as in Search; until that score is read it draws
        // nothing rather than a Bookmark that would vanish a moment later.
        saved={isRanked ? null : watchlistToggle.isSaved(credit.mediaItemId)}
        busy={watchlistToggle.busy === credit.mediaItemId}
        onRank={() => openRank(credit)}
        onToggleWatchlist={() => void toggleWatchlist(credit)}
      />
    );
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
               * **The filmography's two control rows** (FU1113-C).
               *
               *     FILMOGRAPHY                                  Movies ▾   ← what kind of work
               *     Cast   Crew                                        ⚙    ← whose half, and how
               *
               * Row 1 is the large section heading with the Movies / TV selector opposite;
               * row 2 is Cast / Crew as quiet text tabs with the Filters & Sort icon
               * opposite. Both are `BrowseControlsRow`, so on a 320pt phone at the largest
               * text size the controls keep their targets and the left side gives way.
               * There is no All: one medium at a time. The sort (Popular, Release date,
               * Highest rated (TMDB)) and the Decade filter live in the icon's sheet; every
               * note about what TMDB kept is unchanged.
               */}
              <BrowseControlsRow
                testID="filmography-header"
                leading={
                  <Text
                    variant="sectionHeaderLarge"
                    tone="action"
                    accessibilityRole="header"
                    accessibilityLabel="Filmography"
                    numberOfLines={1}
                  >
                    Filmography
                  </Text>
                }
                trailing={
                  roleCredits.length ? (
                    <MediumSelector
                      size="filter"
                      value={shownMedium}
                      options={MEDIUM_CHOICES}
                      accessibilityHint="Choose Movies or TV"
                      testID="filmography-medium"
                      onChange={(next) => {
                        setMedium(next);
                        // A different list: its first page, and no decade chosen over the
                        // other medium (it may have nothing in it here). The order is kept.
                        setDecades([]);
                        setShown(PAGE);
                      }}
                    />
                  ) : undefined
                }
              />

              {(hasCast && hasCrew) || roleCredits.length > 1 ? (
                <View style={styles.controls}>
                  <BrowseControlsRow
                    testID="filmography-controls"
                    leading={
                      hasCast && hasCrew ? (
                        // `SegmentedTabs` sets itself on the gutter, which the row already
                        // pads; the margin hands that gutter back so Cast sits on it once.
                        <View style={styles.roleTabs}>
                          <SegmentedTabs
                            options={ROLE_TABS}
                            value={shownRole}
                            accessibilityLabel="Cast or crew"
                            onChange={(next) => {
                              setRole(next);
                              // A different list: its first page, its own default medium,
                              // no decade. The order is kept: it is the reader's question,
                              // and it means the same thing in either half.
                              setMedium(null);
                              setDecades([]);
                              setShown(PAGE);
                            }}
                          />
                        </View>
                      ) : undefined
                    }
                    trailing={
                      roleCredits.length > 1 ? (
                        <FilterIconButton
                          activeCount={decades.length ? 1 : 0}
                          accessibilityLabel={filterSortSpoken(axes, activeSort, decades.length ? 1 : 0)}
                          announceCount={false}
                          accessibilityHint="Opens the sort order and filters"
                          onPress={() => setFiltering(true)}
                          testID="filmography-filter-sort"
                        />
                      ) : undefined
                    }
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
                         * **Search's row controls, exactly** (`TitleRowActions`, FU1113-C;
                         * `app/(tabs)/log.tsx` builds the same props): a title the reader has
                         * ranked draws their score circle and nothing else, so its trailing
                         * area is never blank; an unranked one draws the compact `+` and the
                         * Bookmark, filled when it is on the watchlist. The score is Search's
                         * read (`useMyScores`), and tapping it opens the same log sheet Search
                         * opens, for a rebucket or a rerank; the title page still offers both
                         * and the watchlist. No `+` until the reader's rankings are known; the
                         * Bookmark waits on the watchlist alone, and nothing here writes the
                         * watchlist except a tap.
                         */
                        trailing={rowActions(credit)}
                      />
                    </Fragment>
                  ))
                ) : decades.length && mediumCredits.length ? (
                  <EmptyState
                    kind="nothingMatches"
                    compact
                    title="Nothing matches"
                    body="Try another decade."
                    action={{ label: 'Clear all', onPress: () => setDecades([]) }}
                  />
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

      {/* Mounted only while open. Sort and Decade apply on the press; Close closes. */}
      {filtering ? (
        <FilmographyFilterSheet
          axes={axes}
          sort={activeSort}
          onSort={(next) => {
            setSort(next);
            // A different order: its first page. Keeping the count would drop the reader
            // into the middle of an order they have not seen the start of.
            setShown(PAGE);
          }}
          decadeOptions={decadeOptions}
          decades={decades}
          onDecades={(next) => {
            setDecades(next);
            setShown(PAGE);
          }}
          onClose={() => setFiltering(false)}
        />
      ) : null}

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
  /**
   * **The filmography's vertical rhythm, by name** (`theme.layout.section`, FU1113-C):
   * the biography (or the identity, with none) to FILMOGRAPHY is `above`, a section's top
   * edge to the page's previous block; the heading row to the Cast / Crew row is
   * `headingToControls`; and
   * those controls to the first credit is `controlsToContent`. The same three whether the
   * biography is long, short or absent, because nothing here depends on it.
   */
  section: { paddingTop: theme.layout.section.above },
  controls: { paddingTop: theme.layout.section.headingToControls },
  // `SegmentedTabs` pads itself by the gutter; the row has already paid it.
  roleTabs: { marginLeft: -theme.layout.gutter },
  list: { paddingTop: theme.layout.section.controlsToContent },
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
