import { useQueryClient } from '@tanstack/react-query';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { Alert, RefreshControl, ScrollView, StyleSheet, View } from 'react-native';

import { useCurrentProfile } from '@/features/auth';
import { unreadCount, useNotifications } from '@/features/notifications/use-notifications';
import { CollectionFilterSheet } from '@/features/collection/CollectionFilterSheet';
import {
  applyFilters,
  emptyFilters,
  isFiltered,
  activeFilterCount,
  type CollectionFilters,
} from '@/features/collection/filters';
import { useLoggedCollection, useWatchlist } from '@/features/collection/use-collection';
import { mustReconcile, newOperationId, setWatchlist } from '@/features/collection/writes';
import { headlineFor, SLATE_SIZE } from '@/features/recommendations/rank';
import { RecommendationRequestsSheet } from '@/features/recommendations/RecommendationRequestsSheet';
import { RequestAlertRow } from '@/features/recommendations/RequestAlertRow';
import {
  useRecommendationRequests,
  useSweepIntent,
} from '@/features/recommendations/use-recommendation-requests';
import { PeopleDiscovery } from '@/features/people/PeopleDiscovery';
import { GroupPicksSheet } from '@/features/recommendations/GroupPicksSheet';
import { SentToYouList } from '@/features/recommendations/SentToYouList';
import { refreshRecommendations } from '@/features/recommendations/session-seed';
import { useDismissTitle } from '@/features/recommendations/use-dismissed';
import {
  MAX_PAGES,
  useForYou,
  type ForYouItem,
  type Medium,
} from '@/features/recommendations/use-for-you';
import {
  asCollectionItem as recommendationAsItem,
  unopenedCount,
  unopenedIsAtLeast,
  useMarkRecommendationOpened,
  useSentToYou,
  type SentRecommendation,
} from '@/features/recommendations/use-sent-to-you';
import { track } from '@/lib/analytics';
import { posterUri } from '@/lib/images';
import { languageName } from '@/lib/language';
import { invalidateAfterWatchlistChange } from '@/features/collection/invalidate';
import { theme } from '@/ui/tokens';
import {
  AppHeader,
  EmptyState,
  FilterChip,
  HeaderBoundary,
  PosterGrid,
  Screen,
  MediumSelector,
  type MediumSelectorOption,
  SkeletonRow,
  Text,
} from '@/ui/components';

/**
 * For You, rebuilt to the shape of Collection (founder pass, 2026-08-17).
 *
 * What it looked like before: a Movies/TV segmented row *under* a For you / Sent to you
 * row, then a heading that said "For you" again, then "Based on your taste", then
 * "Inspired by Inception, Heat + more", and only then artwork. Four bands of prose in
 * front of a wall whose entire proposition is the artwork.
 *
 * All four are gone. The founder's rule is the one Collection already follows: category
 * across the top, one filter row, then straight into the wall. A screen called For you,
 * reached from a tab called For you, does not need a heading that says For you, and the
 * claim underneath it was a sentence nobody read twice.
 *
 * **Sent to you is a filter, not a tab.** It sat as a peer of the whole engine, which
 * made the top of the screen a two-level navigation for one wall. As the first chip in
 * the filter row it is what it always was, a narrowing of "things to watch" down to
 * "things people sent me", and the other chips keep working across it, which is what
 * makes "Comedy, from friends" a thing anybody can ask for.
 *
 * **The filters are one state across everything**, deliberately. Choosing Comedy is a
 * statement about what the reader is in the mood for, not about which list they happen
 * to be looking at. Nothing about filtering touches a recommendation record: it narrows
 * what is drawn and that is all.
 *
 * For You is a wall of artwork; Sent to you is a list. See `SentToYouList` for why they
 * differ.
 */
export default function RecommendationsScreen() {
  const router = useRouter();
  const profile = useCurrentProfile();
  const queryClient = useQueryClient();
  const notifications = useNotifications(profile.id);

  /**
   * Whether the People suggestions are showing instead of the title wall.
   *
   * **A boolean, with the selector's third option derived from it** (2026-09-07).
   * People is an option in the dropdown again — it is an answer to "what am I looking
   * at", which is the question that control asks — but it is deliberately not a value
   * `medium` can hold. Keeping it as its own flag is what stops a glance at People from
   * moving the slate query to Movies and throwing away a TV wall somebody scrolled; see
   * `category` below, which is the one place the two are combined.
   *
   * State rather than a route, unchanged: a route would put People in the back stack and
   * make the tab bar's "back to the top of For You" gesture land somewhere the reader
   * did not leave. Every filter and scroll position on the title side survives a look at
   * People and back, which is what a control living *inside* a screen implies.
   *
   * Deliberately not persisted. Collection remembers its side because a TV-heavy reader
   * opens the same list every day; For You is a question asked fresh each visit, and an
   * app that reopened on People because somebody once looked there would be answering a
   * question nobody asked twice.
   *
   * **Except on arrival by `PEOPLE_DISCOVERY`** (2026-09-07). The end of onboarding and
   * an empty Feed both send people here *to find people*, and this parameter is how
   * they say so. Read at mount and consumed on change, the way the profile tab reads
   * its `awards` parameter: a tab stays mounted, so an initial-state read alone would
   * open nothing for somebody who had already visited For You, and the parameter is
   * cleared in the same breath so that choosing Movies afterwards is not undone by a
   * value still sitting in the URL.
   */
  const { show } = useLocalSearchParams<{ show?: string }>();
  const [peopleOpen, setPeopleOpen] = useState(show === 'people');
  useEffect(() => {
    if (show === 'people') {
      // Synchronising FROM an external system — the URL — which is the case the
      // rule's own doc carves out; the param is consumed in the same breath, so this
      // fires once per arrival, not per render.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setPeopleOpen(true);
      router.setParams({ show: undefined });
    }
  }, [show, router]);
  /**
   * The title side the reader is on, and it is untouched by a visit to People.
   *
   * People is not a medium, so there is no honest value for this while it is showing —
   * and deriving one would silently move the slate query to Movies the moment somebody
   * glanced at People from TV shows, throwing away a wall they had scrolled. Holding it
   * separately means the visit costs the slate nothing at all.
   */
  const [medium, setMedium] = useState<Medium>('movies');
  /** The first chip. Not a tab: see the header. */
  const [sentOnly, setSentOnly] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [filters, setFilters] = useState<CollectionFilters>(emptyFilters());
  const [filtering, setFiltering] = useState(false);
  /**
   * The Group Picks sheet. Mounted only while open, which is what makes the group
   * ephemeral: the member selection is the sheet's own state, so closing discards it
   * and reopening starts clean. The sheet owns its own filters for the same reason.
   */
  const [groupPicking, setGroupPicking] = useState(false);
  /** The Requests sheet. Nothing else on this screen knows it exists. */
  const [reviewingRequests, setReviewingRequests] = useState(false);
  /**
   * The Dismiss all intent, held here rather than inside the sheet.
   *
   * The sheet is unmounted every time it closes, so anything it owned would be cleared
   * by the most ordinary recovery a reader has: a sweep fails, they close the sheet,
   * look at the list, open it and try again. A fresh operation id on that retry walks
   * past `_claim_operation` and dismisses whatever arrived in between — recommendations
   * they never saw, which is the one thing this tranche exists to make impossible.
   *
   * This screen is a tab and outlives every open and close of the sheet, so it is the
   * longest scope that is still honest. `useSweepIntent` carries the rest of the
   * reasoning, including why the in-flight guard has to live here too.
   */
  const sweepIntent = useSweepIntent();

  /**
   * The media universe the wall is about — Movies or TV shows.
   *
   * **Switching sides no longer throws the other side's depth away** (founder,
   * 2026-09-06). `pages` used to be one number reset to 1 on every change, so a reader
   * four pages into Movies who glanced at TV and came back was handed page one again.
   * The two sides keep their own depth now, which is what makes Movies → TV → Movies
   * cost nothing: the slate itself was always cached per medium by React Query, and the
   * page count was the only thing being discarded.
   *
   * Choosing a media tab also leaves People, because tapping Movies while looking at a
   * list of people plainly means "show me the films".
   */
  const changeCategory = (next: ForYouCategory) => {
    setPeopleOpen(next === 'people');
    // People is not a medium, so it leaves `medium` alone — which is what keeps the
    // wall, its filters and its per-medium depth exactly where the reader left them.
    if (next !== 'people') setMedium(next);
  };

  /**
   * What the selector shows, derived rather than stored.
   *
   * Two pieces of state (is People showing, which media side) and one control over
   * both, so the control's value is computed from them instead of being a third thing
   * that could disagree with either. This is the seam that lets People be an option in
   * the dropdown without being a `medium` the slate query could ever be asked for.
   */
  const category: ForYouCategory = peopleOpen ? 'people' : medium;

  /**
   * Filters, and the page count that has to move with them.
   *
   * One setter rather than three call sites each remembering to reset. The pool a page is
   * drawn from changes when the filters do, so a reader four pages into an unfiltered
   * wall who then picks Comedy would otherwise be handed eighty Comedy titles at once —
   * most of them the weak tail — instead of the best twenty.
   */
  const changeFilters = (next: CollectionFilters) => {
    setFilters(next);
    resetPages();
  };

  /**
   * How many diversified pages the wall is showing (founder §18).
   *
   * Reset whenever the reader changes what they are looking at — a new medium or new
   * filters is a new question, and arriving at page four of the old one would be the
   * scroll position surviving a change it should not have.
   */
  /**
   * **Per medium, since 2026-09-06.** It was one number reset to 1 whenever the reader
   * changed sides, so glancing at TV and coming back handed a reader four pages into
   * Movies their first page again. The slate itself was always cached per medium by
   * React Query; the page count was the only thing a switch destroyed, and it did not
   * have to.
   *
   * Filters and an explicit refresh still reset **both** sides, and that is correct:
   * those change what the question *is*, and a stale depth into an answer to a
   * different question is not depth worth keeping.
   */
  const [pagesByMedium, setPagesByMedium] = useState<Record<Medium, number>>({
    movies: 1,
    tv: 1,
  });
  const pages = pagesByMedium[medium];
  const setPages = (next: number) =>
    setPagesByMedium((current) => ({ ...current, [medium]: next }));
  const resetPages = () => setPagesByMedium({ movies: 1, tv: 1 });
  const slate = useForYou(profile.id, medium, filters, pages);
  const logged = useLoggedCollection(profile.id);
  const sent = useSentToYou(profile.id);
  /**
   * The held half. Read here rather than inside the sheet, because the compact row
   * above the filters has to know whether there is anything to say **before** anybody
   * opens anything — and the count it draws must be the same object the sheet lists.
   */
  const requests = useRecommendationRequests(profile.id);
  const watchlist = useWatchlist(profile.id);
  const markOpened = useMarkRecommendationOpened(profile.id);
  const dismissTitle = useDismissTitle(profile.id);

  const items = slate.data?.items ?? [];
  const sentRows = sent.data ?? [];

  /**
   * Whether asking for another page could produce anything.
   *
   * `diversifyPaged` returns short when the candidate pool runs out, so a wall holding
   * fewer than `pages × SLATE_SIZE` titles has already been told there is no more —
   * which is a better signal than a count, because it accounts for the diversity
   * ceilings rejecting the tail as well as for the pool being empty.
   */
  const exhausted = pages >= MAX_PAGES || items.length < pages * SLATE_SIZE;

  /**
   * One more page, when the reader reaches the end of this one.
   *
   * Costs nothing over the network: `pages` feeds `select`, which re-derives from
   * candidates already in the cache. So this is a sort rather than a fetch, and there is
   * no request to debounce, fail, or loop on — which is the founder's "no infinite
   * request loop" satisfied by there being no request.
   */
  const loadMore = () => {
    if (exhausted) return;
    /**
     * `pages + 1`, and **not** the functional `current => current + 1`.
     *
     * `onScroll` fires about once a frame, so a fast flick near the bottom delivers
     * several events before React re-renders. Every one of them sees the same `exhausted`
     * from this render and calls this. With the functional form each queued update would
     * increment, so one gesture could take the wall from twenty titles to a hundred in a
     * single commit — five pages of posters mounted at once, which is the kind of thing
     * that shows up as heat on a real device rather than as a failing test.
     *
     * Setting a *value* makes the repeated calls idempotent: they all write the same
     * number, so the wall grows by exactly one page per render however many events
     * arrive. The next page needs the next render, by which time `exhausted` has been
     * recomputed against the wall that actually came back.
     */
    setPages(Math.min(MAX_PAGES, pages + 1));
  };

  /**
   * A new arrangement and a fresh first page.
   *
   * **This is what replaced the Refresh chip** (§18). The founder's end state is that a
   * reader should never have to think "I need to press Refresh to make recommendations
   * work", and after this tranche they do not: the wall rotates across launches on its
   * own, from `recommendation_exposure`. What is still needed is an *explicit* way to ask
   * for a different slate now — the founder was clear that Refresh should not be removed
   * merely for looks if one is still required — and pull-to-refresh is that way. It is
   * already the gesture on this screen for the Sent to you list and on the Feed, so it is
   * a control the reader has met rather than a new one.
   *
   * `refreshRecommendations` advances the seed and marks everything currently on screen
   * as shown; `resetPages()` puts the reader back at a first page, because a refreshed
   * wall they are four pages down inside is a wall whose change they cannot see.
   */
  const refreshSlate = () => {
    refreshRecommendations();
    resetPages();
  };

  // Filtered here rather than in the query, so turning the chip on cannot refetch and
  // cannot reorder: the server's ordering survives, narrowed.
  const sentShown = applyFilters(sentRows.map(recommendationAsItem), filters);
  const sentVisible = sentRows.filter((row) =>
    sentShown.some((item) => item.mediaItemId === row.mediaItemId),
  );

  const savedIds = new Set((watchlist.data ?? []).map((row) => row.mediaItemId));

  const toggleSaveById = async (mediaItemId: string, present: boolean) => {
    if (busy) return;
    setBusy(mediaItemId);
    const result = await setWatchlist({
      operationId: newOperationId(),
      mediaItemId,
      present,
    });
    setBusy(null);

    // Additions only, and only on `ok` — the same rule as the other three bookmarks.
    if (present && result.outcome === 'ok') {
      track({ name: 'watchlist_added', props: { surface: 'for_you' } });
    }

    /**
     * Reconciled on an unknown outcome as well as on success — the same rule the other
     * three bookmark surfaces follow (`lib/write-outcome.ts`). Independent review 21e,
     * and unchanged: the canonical watchlist is refetched, so the bookmark ends up
     * showing what the server actually holds rather than what the tap intended.
     *
     * **What is gone is the second line, and it was the founder's Preview bug.** This
     * also did `invalidateQueries(['for-you', profile.id])`, because the slate used to
     * carry `saved` on every item and had to be refetched to redraw one icon. Between
     * that and the watchlist being part of the slate's query key, a bookmark discarded
     * the whole wall: skeleton, white flash, a new `ScrollView`, and the reader back at
     * the top of a list they were halfway down.
     *
     * The wall is not a function of the watchlist. `buildSlate` says so — a saved title
     * stays on the wall and is marked, rather than being removed — so the only thing
     * that changed is which bookmark is filled, and that is read live from
     * `useWatchlist` below. Watchlist state changing is not the recommendation wall
     * becoming wrong.
     */
    if (mustReconcile(result)) {
      // The watchlist and Queue Dragon, which counts it (`collection/invalidate.ts`).
      invalidateAfterWatchlistChange(queryClient, profile.id);
    }

    if (result.outcome === 'failed') {
      Alert.alert('Could not update watchlist', result.message);
      return;
    }
  };

  const openRecommendation = (row: SentRecommendation) => {
    // Opened is recorded on the way through, which is the only moment anybody can
    // honestly call it opened. It is fire-and-forget: a failure here must not stand
    // between somebody and the title they were told to watch.
    // `recommendation_opened` is emitted by the mutation, once the server has answered
    // and once per row — not here on the tap, which reads a cached `openedAt` and would
    // fire twice for two quick presses. See `useMarkRecommendationOpened`.
    if (!row.openedAt) {
      markOpened.mutate({
        recommendationId: row.id,
        mediaKind: row.kind === 'movie' ? 'movie' : 'tv_season',
      });
    }
    // Who sent it and when travel with the link, so the title page can say so over its
    // hero. The fact belongs to this route and not to the title: the same film reached
    // from search is not "recommended by Ada", and a lookup on every title page would
    // be a round trip to answer a question only this one asks.
    // The object form rather than a query string, because typed routes only accept a
    // path that matches a known pattern and `/title/x?y=z` matches none of them.
    router.push({
      pathname: '/title/[id]',
      params: { id: row.mediaItemId, recBy: row.senderName, recAt: row.recommendedAt },
    });
  };

  /**
   * Why this tile is here, on a long press.
   *
   * **Production gets the sentence and nothing else** (pre-GTM audit, 2026-09-07). This
   * used to put `score 0.412`, the anchor contributions and the popularity prior in
   * front of anybody who held a poster — the working the engine shows a developer, in
   * the vocabulary of `rank.ts`, on a store build. The sentence `headlineFor` derives is
   * the explanation PRD §13 requires and the only one a reader is owed: "Because you
   * loved Heat", "More drama, which you rank highly", "Popular right now".
   *
   * The raw diagnostics survive in local development only — `__DEV__`, a dev client
   * attached to Metro — and nowhere else (founder decision, 2026-09-07). The first cut of
   * this gated them on `diagnosticsAvailable`, which is beta and below, on the reasoning
   * that a beta tester holding a poster is who the working is for. The founder's ruling
   * is that a community beta build is a stranger's build for this purpose: the same
   * sentence a store user gets, and nothing in `rank.ts` vocabulary. The Diagnostics
   * sheet keeps its own wider gate; this one is narrower on purpose.
   */
  const explain = (item: ForYouItem) => {
    const { explanation } = item;
    const taste = slate.data?.taste;
    if (!taste) return;

    // The real taste, not a stand-in. A stand-in with a large `sampleSize` was
    // defeating the suppression that stops a taste built from one ranking being
    // asserted in words, so this panel showed a sentence the wall would not.
    const headline = headlineFor(explanation, taste, (code) => languageName(code) ?? code);

    if (!__DEV__) {
      Alert.alert(item.title, headline);
      return;
    }

    const lines = [
      headline,
      `score ${explanation.total.toFixed(3)}`,
      explanation.anchors.length
        ? `anchors: ${explanation.anchors
            .map((hit) => `${hit.title} (#${hit.position}, +${hit.contribution.toFixed(2)})`)
            .join(', ')}`
        : 'anchors: none',
      explanation.genre
        ? `genre: ${explanation.genre.genre} ${explanation.genre.affinity.toFixed(2)}`
        : 'genre: none',
      explanation.language
        ? `language: ${explanation.language.code} ${explanation.language.affinity.toFixed(2)}`
        : 'language: none',
      `popularity prior: ${explanation.popularity.toFixed(2)}`,
    ].filter(Boolean);

    Alert.alert(item.title, lines.join('\n'));
  };

  const unopened = unopenedCount(sentRows);
  // The server caps this list at 200 and orders unopened first, so a full page of
  // unopened rows means there may be more (`use-sent-to-you.ts`). The chip says so
  // rather than presenting a cap as a total. Independent review 21c.
  const atLeast = unopenedIsAtLeast(sentRows);
  const activeCount = activeFilterCount(filters);
  // Items, not senders, and the server's own count rather than the length of a capped
  // list — see `useRecommendationRequests`.
  const requestCount = requests.data?.total ?? 0;

  return (
    <Screen>
      <AppHeader
        notifications={{
          count: unreadCount(notifications.data),
          onPress: () => router.push('/settings/notifications'),
        }}
      />

      {/**
       * **Movies, TV shows, People** — one selector, and the founder's answer to Bingd
       * having no way to find anybody (tranche 2026-08-26 §10, revised).
       *
       * For You is the screen that answers "what next", and the honest answer is
       * sometimes a film and sometimes a person. People was first built as a segmented
       * control *above* this one, which gave the screen two selectors stacked in its
       * header: a reader had to work out that the top one chose a kind of thing and the
       * bottom one chose a category of the thing the top one had chosen. It is one
       * question — what am I looking at — so it is one control, and People is a third
       * option in the control that was already asking it.
       *
       * The same control Collection leads with, in the same place, doing the same job.
       * "TV shows" rather than "TV seasons" because this wall holds series: TMDB answers
       * "similar" about a show and never about one of its seasons. Collection keeps its
       * own two options and its own label — see `MediumSelector`.
       */}
      {/**
       * **Restored, with People back in it** (founder, physical Android, 2026-09-07).
       *
       * These were visible tabs for a day, and People was demoted to a chip beside Sent
       * to you. On a device the tab row drew differently here than on Collection — the
       * two screens are supposed to lead with the same control — and People as a chip
       * sat in a row of *filters*, where a thing that replaces the entire wall does not
       * belong. Both problems are the same problem: the screen has one question at the
       * top, and splitting it across two control languages is what made it look split.
       *
       * The dropdown is also the only one of the two that scales. Movies and TV shows
       * are not necessarily the last categories this screen will offer, and a fourth
       * tab is a wrapped row where a fourth sheet row is a fourth sheet row.
       */}
      <MediumSelector
        value={category}
        onChange={changeCategory}
        options={FOR_YOU_CATEGORIES}
      />
      {/* Outside the branch, because the selector above it is now the screen's entire
      header and the seam it marks is the same one whichever category is showing. */}
      <HeaderBoundary />

      {peopleOpen ? (
        // No filter row: none of the genre chips narrows a list of people, and drawing
        // them here would offer controls that do nothing. The way back is the selector
        // above, which reads "People" with its chevron — the same control that got here.
        <PeopleDiscovery viewerId={profile.id} />
      ) : (
        <>
          {/* Above the filters, and only when something is waiting.

          It sits here rather than in the filter row because it is not a filter: the
          chips narrow what is on screen, and this says that there is something *not*
          on screen yet which needs a decision. Absent at zero, with no placeholder and
          no empty state — a row that is always there stops being a signal. */}
          {requestCount > 0 ? (
            <RequestAlertRow count={requestCount} onPress={() => setReviewingRequests(true)} />
          ) : null}

          {/* One row, wrapping. Sent to you leads because it is the only chip that changes
          what kind of thing is on screen; the rest narrow whatever is. Clear all appears
          only when there is something to clear, and clears the *filters*: turning off
          Sent to you as well would make one control mean two things. */}
          <View style={styles.filterRow}>
            <FilterChip
              icon={sentOnly ? 'mail-open' : 'mail-outline'}
              label={
                unopened > 0 ? `Sent to you · ${unopened}${atLeast ? '+' : ''}` : 'Sent to you'
              }
              accessibilityLabel={
                unopened > 0
                  ? `Sent to you, ${atLeast ? 'at least ' : ''}${unopened} unopened`
                  : 'Sent to you'
              }
              selected={sentOnly}
              onPress={() => setSentOnly((on) => !on)}
            />
            {/* People is not a chip in this row (founder, 2026-09-07). It replaces the
                entire wall, and every other control here narrows the wall that is
                already showing — it belongs in the selector at the top with the other
                answers to "what am I looking at", and that is where it lives again. */}
            {/* An action chip rather than a filter: it opens the flow that answers "what
            should this group watch together". Deliberately not a fourth MediumSelector
            segment and not a tab — a group is a momentary question, and this row is
            where the screen keeps its questions. The wall the chip sits on decides the
            medium the picks answer for. */}
            <FilterChip
              icon="people-outline"
              label="Group Picks"
              onPress={() => {
                track({ name: 'group_picks_opened' });
                setGroupPicking(true);
              }}
            />
            {/* The collection's own sheet, which its header always intended this screen to
            reuse rather than growing a second one. Genre, Language, Decade and Anime
            come with it. Rating filters are off: nothing on either list has been ranked
            by this reader. */}
            <FilterChip
              icon="options-outline"
              label={activeCount ? `Filters · ${activeCount}` : 'Filters'}
              selected={activeCount > 0}
              onPress={() => setFiltering(true)}
            />
            {/* **The Refresh chip was here, and it is gone** (founder §18).

            It existed because the wall could not rotate by itself: exposure was module
            state, so every launch drew from an un-penalised pool and produced the same
            first slate, and pressing Refresh was the only way past it. That was the
            reader having to know a mechanism, which is exactly what §18 asks to remove —
            "the user should not have to think: I need to press Refresh to make
            recommendations work".

            Two changes let it go rather than a decision that the row looked busy, which
            the founder ruled out as a reason on its own. `recommendation_exposure`
            (20260828000500) makes the rotation survive a relaunch, so the *default*
            behaviour is now what Refresh used to buy. And an explicit way to ask for a
            new slate still exists: pull-to-refresh on the wall, which runs the same
            `refreshRecommendations` this chip did. A gesture the screen already had for
            Sent to you, rather than a control competing with the filters. */}
            {isFiltered(filters) ? (
              <FilterChip
                icon="close"
                label="Clear all"
                onPress={() => changeFilters(emptyFilters())}
              />
            ) : null}
          </View>

          {sentOnly ? (
            <SentList
              query={sent}
              rows={sentVisible}
              total={sentRows.length}
              saved={savedIds}
              busyId={busy}
              onOpen={openRecommendation}
              onToggleSave={(row) =>
                void toggleSaveById(row.mediaItemId, !savedIds.has(row.mediaItemId))
              }
            />
          ) : slate.isError ? (
            <EmptyState
              kind="couldNotLoad"
              title="Could not load recommendations"
              body="Check your connection and try again."
              action={{ label: 'Try again', onPress: () => void slate.refetch() }}
            />
          ) : slate.isPending ? (
            <SkeletonRow count={6} />
          ) : items.length === 0 ? (
            <Nothing
              medium={medium}
              ranked={logged.data?.rankedCount ?? 0}
              filtered={isFiltered(filters)}
              onRank={() => router.push('/log')}
              onClearFilters={() => changeFilters(emptyFilters())}
            />
          ) : (
            <ScrollView
              contentContainerStyle={styles.content}
              /**
               * The wall grows as the reader nears its end (§18).
               *
               * `onScroll` with a threshold rather than a `FlatList`'s `onEndReached`,
               * because the wall is a `PosterGrid` inside a `ScrollView` and converting it
               * to a virtualised list is a change to how every tile is measured and drawn —
               * a bigger risk than this tranche is buying. The grid is at most a hundred
               * posters under `MAX_PAGES`, which is well inside what a `ScrollView` renders
               * comfortably.
               *
               * `scrollEventThrottle` at 16 is one event a frame; `loadMore` is a no-op
               * once the pool is exhausted, so the common case at the bottom of the wall is
               * a comparison and a return.
               */
              scrollEventThrottle={16}
              onScroll={({ nativeEvent }) => {
                const { layoutMeasurement, contentOffset, contentSize } = nativeEvent;
                const remaining =
                  contentSize.height - (contentOffset.y + layoutMeasurement.height);
                // Two screenfuls of slack, so the next page is already there by the time
                // the reader arrives rather than appearing under their thumb.
                if (remaining < layoutMeasurement.height * 2) loadMore();
              }}
              refreshControl={
                <RefreshControl
                  // The only way a test can reach a pull. There is no accessible name on
                  // a refresh control and no role to query it by, and asserting on the
                  // gesture matters more than usual here: it is the *replacement* for a
                  // control that was removed, so a wiring mistake would look exactly like
                  // the feature having been dropped.
                  testID="for-you-refresh"
                  // Not `slate.isRefetching`: this gesture rearranges rather than
                  // refetching, and it completes in one render. Tying the spinner to a
                  // query that never runs would leave it spinning for ever.
                  refreshing={false}
                  onRefresh={refreshSlate}
                  tintColor={theme.semantic.action}
                  colors={[theme.semantic.action]}
                />
              }
            >
              {/**
               * **What this wall is, when it is not yet the reader's** (pre-GTM audit,
               * 2026-09-07).
               *
               * `lowData` is the hook's own word for a slate scored with no resolved
               * anchors — a wall drawn from the popularity fallback and the genre
               * affinity of a taste too thin to quote. A stranger who has ranked two
               * films sees exactly this wall, and without a word for it the screen called
               * For You is presenting last week's trending page as personalisation.
               * One quiet line in the footnote register the exhausted notice already
               * uses, above the artwork, and gone the moment an anchor resolves. Not a
               * header, not a card, and nothing about the slate itself moved.
               */}
              {slate.data?.lowData ? (
                <Text variant="footnote" tone="tertiary" style={styles.lowData}>
                  Popular right now while bingd. learns your taste.
                </Text>
              ) : null}
              <PosterGrid
                tiles={items.map((item) => ({
                  id: item.mediaItemId,
                  title: item.title,
                  year: item.year,
                  posterUri: posterUri(item.posterPath, 'card'),
                  // Read live from the watchlist query, not carried on the slate. That is
                  // what lets a bookmark redraw one icon instead of replacing the wall —
                  // see `toggleSaveById`.
                  saved: savedIds.has(item.mediaItemId),
                  // Deliberately no score. Nothing here has been watched, so a score would
                  // have to be somebody else's, and a rating filter over unseen titles is
                  // the thing the collection filter sheet already refuses.
                }))}
                onPressTile={(tile) => router.push(`/title/${tile.id}`)}
                onToggleSave={(tile) => {
                  const item = items.find((candidate) => candidate.mediaItemId === tile.id);
                  if (item)
                    void toggleSaveById(item.mediaItemId, !savedIds.has(item.mediaItemId));
                }}
                // The founder's X (§12): the card goes on the tap — the optimistic
                // set feeds `useForYou`'s select, so no refetch and no flash — and
                // the write persists it. Only a proven refusal is worth an alert.
                onDismissTile={(tile) => {
                  void dismissTitle(tile.id).then((result) => {
                    if (!result.ok) Alert.alert('Could not hide this', result.message);
                  });
                }}
                onLongPressTile={(tile) => {
                  const item = items.find((candidate) => candidate.mediaItemId === tile.id);
                  if (item) explain(item);
                }}
              />

              {/**
               * The end of the wall, said once, quietly (§18).
               *
               * The founder's rule is not to keep recycling the same five cards at the
               * bottom — so when the pool is out the wall simply stops, and this line
               * says why in the one way that is both true and actionable. It is not a
               * button: the reader is on a wall of recommendations and the thing to do
               * about a thin one is to rank more, which the Log tab already offers.
               *
               * Only under a wall with something on it. Under an empty one `Nothing`
               * has already said something better, and two explanations of the same
               * absence is worse than either.
               */}
              {exhausted && items.length > 0 ? (
                <Text variant="footnote" tone="tertiary" style={styles.exhausted}>
                  Rank a few more titles to sharpen your recommendations.
                </Text>
              ) : null}
            </ScrollView>
          )}

          {filtering ? (
            <CollectionFilterSheet
              // The options describe whatever is in front of the reader, so a Sent to you
              // list of four films does not offer twenty genres none of them are.
              items={
                sentOnly
                  ? sentRows.map(recommendationAsItem)
                  : (slate.data?.candidatePool ?? [])
              }
              value={filters}
              showBuckets={false}
              onApply={(next) => {
                changeFilters(next);
                setFiltering(false);
              }}
              onClose={() => setFiltering(false)}
            />
          ) : null}

          {groupPicking ? (
            <GroupPicksSheet
              viewerId={profile.id}
              medium={medium}
              onClose={() => setGroupPicking(false)}
            />
          ) : null}

          {/* The held recommendations, and the three decisions each one carries.

          Mounted only while open, so the sheet's queries are not kept warm behind a
          screen most visits never open — the compact row above already knows the count
          from a query this screen owns. */}
          {reviewingRequests ? (
            <RecommendationRequestsSheet
              viewerId={profile.id}
              onClose={() => setReviewingRequests(false)}
              onPressProfile={(username) => router.push(`/u/${username}`)}
              sweepIntent={sweepIntent}
            />
          ) : null}
        </>
      )}
    </Screen>
  );
}

/**
 * The three things this screen can be showing.
 *
 * The two title categories come from the shared table rather than being restated here,
 * so "Movies" cannot come to mean one thing on Collection and another here; People is
 * the addition, and the only one this screen owns.
 */
/**
 * The two primary tabs, keyed by **this screen's** medium rather than the collection's.
 *
 * `Medium` here is `'movies' | 'tv'` and Collection's is `'movies' | 'tv_seasons'`,
 * because the units genuinely differ: TMDB answers "similar" about a *show* and never
 * about one of its seasons, so this wall holds series. That is also why the label reads
 * "TV shows" and Collection's reads "TV" — one accurate word each, rather than one
 * shared table forcing both to say the same slightly-wrong thing.
 *
 * The mapping table this replaced existed only to translate between the two, and the
 * translation existed only because the control was shared. The control is a tab row now
 * and takes this screen's own ids directly.
 */
type ForYouCategory = Medium | 'people';

const FOR_YOU_CATEGORIES: readonly MediumSelectorOption<ForYouCategory>[] = [
  { id: 'movies', label: 'Movies' },
  { id: 'tv', label: 'TV shows' },
  { id: 'people', label: 'People' },
];

/**
 * The human half.
 *
 * Three empty states rather than one, because they mean three different things and only
 * one of them is the reader's to fix: nobody has sent you anything, the filters have
 * hidden everything that was sent, or the list could not load.
 */
function SentList({
  query,
  rows,
  total,
  saved,
  busyId,
  onOpen,
  onToggleSave,
}: {
  query: ReturnType<typeof useSentToYou>;
  rows: SentRecommendation[];
  total: number;
  saved: ReadonlySet<string>;
  busyId: string | null;
  onOpen: (row: SentRecommendation) => void;
  onToggleSave: (row: SentRecommendation) => void;
}) {
  if (query.isPending) return <SkeletonRow count={5} />;

  if (query.isError) {
    return (
      <EmptyState
        kind="couldNotLoad"
        title="Could not load these"
        body="Check your connection and try again."
        action={{ label: 'Try again', onPress: () => void query.refetch() }}
      />
    );
  }

  if (total === 0) {
    return (
      <EmptyState
        kind="nothingYet"
        title="Nothing sent your way yet"
        body="When someone you follow back recommends a film or a season, it lands here."
      />
    );
  }

  if (rows.length === 0) {
    return (
      // No button. Clear all is already on screen, in the chip row a few points above
      // this, and a second one with the same label is the duplicated state the founder
      // rejected on the Feed: the reader would have to work out whether the two do the
      // same thing.
      <EmptyState
        kind="nothingYet"
        title="Nothing matches your filters"
        body="Clear your filters to see everything people have sent you."
      />
    );
  }

  return (
    <ScrollView
      contentContainerStyle={styles.content}
      refreshControl={
        <RefreshControl
          refreshing={query.isRefetching}
          onRefresh={() => void query.refetch()}
          tintColor={theme.semantic.action}
          colors={[theme.semantic.action]}
        />
      }
    >
      <SentToYouList
        rows={rows}
        saved={saved}
        busyId={busyId}
        onOpen={onOpen}
        onToggleSave={onToggleSave}
      />
    </ScrollView>
  );
}

/**
 * Nothing to show, which has three quite different causes and needs three answers.
 *
 * A reader who has ranked nothing needs to rank something. A reader who has filtered the
 * wall down to nothing needs the filter gone, and telling them to rank more would be
 * answering a question they did not ask. A reader who has ranked plenty and still sees
 * an empty wall has hit a data problem, no cached candidates yet, and blaming them for
 * it would be worse than saying nothing.
 */
function Nothing({
  medium,
  ranked,
  filtered,
  onRank,
  onClearFilters,
}: {
  medium: Medium;
  ranked: number;
  filtered: boolean;
  onRank: () => void;
  onClearFilters: () => void;
}) {
  if (filtered) {
    return (
      <EmptyState
        kind="nothingMatches"
        title="Nothing matches your filters"
        body="Try removing one, or clear them and start again."
        action={{ label: 'Clear all', onPress: onClearFilters }}
      />
    );
  }

  if (ranked === 0) {
    return (
      <EmptyState
        kind="nothingYet"
        title="Rank a few things first"
        body="Recommendations need a little of your taste to work from."
        action={{ label: 'Rank something', onPress: onRank }}
      />
    );
  }

  return (
    <EmptyState
      kind="nothingYet"
      title={medium === 'tv' ? 'Nothing to suggest yet' : 'Still gathering suggestions'}
      body={
        medium === 'tv'
          ? 'Rank a season or two and this fills up with shows.'
          : 'This fills in as the catalogue learns what your favourites are near.'
      }
      action={{ label: 'Rank something', onPress: onRank }}
    />
  );
}

const styles = StyleSheet.create({
  content: { paddingBottom: theme.space[10], gap: theme.space[3] },
  exhausted: {
    paddingHorizontal: theme.layout.gutter,
    paddingTop: theme.space[4],
    textAlign: 'center',
  },
  lowData: {
    paddingHorizontal: theme.layout.gutter,
    textAlign: 'center',
  },
  filterRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    columnGap: theme.space[2],
    rowGap: theme.space[2],
    paddingHorizontal: theme.layout.gutter,
    paddingTop: theme.space[3],
    paddingBottom: theme.space[2],
  },
});
