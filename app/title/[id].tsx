import { Ionicons } from '@expo/vector-icons';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useMemo, useState } from 'react';
import {
  Alert,
  Linking,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  View,
} from 'react-native';

import { useCurrentProfile } from '@/features/auth';
import { LogSheet, type LoggableTitle, type PostRank } from '@/features/collection/LogSheet';
import { BUCKET_IDS } from '@/features/collection/use-log-state';
import { heroRankFor } from '@/features/collection/hero-rank';
import { useCompanions } from '@/features/collection/use-companions';
import { useRankedCollection, type RankingCategory } from '@/features/collection/use-collection';
import { useTitleScore } from '@/features/collection/use-score';
import { shouldMask, useWatched } from '@/features/collection/use-watched';
import {
  invalidateAfterCollectionChange,
  invalidateAfterWatchlistChange,
} from '@/features/collection/invalidate';
import {
  mustReconcile,
  newOperationId,
  removeFromCollection,
  setWatchlist,
} from '@/features/collection/writes';
import { RankingSheet, type RankingSubject } from '@/features/ranking/RankingSheet';
import { RecommendSheet } from '@/features/recommendations/RecommendSheet';
import { useSeasons } from '@/features/search/use-title-search';
import { useCommunityScore } from '@/features/title/use-community-score';
import { useFollowingScore } from '@/features/title/use-following-score';
import { useCredits } from '@/features/title/use-credits';
import { useTitleEnrichment } from '@/features/title/use-enrichment';
import { TitleReviews } from '@/features/title/TitleReviews';
import { useTitleVideos } from '@/features/title/use-title-extras';
import { useTitleReviews, type ReviewSort } from '@/features/title/use-title-reviews';
import { diagnose } from '@/lib/diagnose';
import { heroArtwork } from '@/lib/hero';
import { languageName } from '@/lib/language';
import { track } from '@/lib/analytics';
import { posterUri, profileUri, videoUri } from '@/lib/images';
import { resolveMetadata } from '@/lib/media-metadata';
import { queryKeys } from '@/lib/query';
import { supabase } from '@/lib/supabase';
import { relativeTime } from '@/features/recommendations/use-sent-to-you';
import { compactName } from '@/lib/titles';
import {
  CastStrip,
  Chip,
  DetailHeaderBackground,
  DetailHeaderTitle,
  EmptyState,
  LoadingScreen,
  PersonalState,
  Poster,
  Screen,
  ScoresSection,
  SegmentedTabs,
  Sheet,
  SheetRow,
  SkeletonRow,
  Text,
  TitleHero,
  TitleRow,
  useDetailHeader,
} from '@/ui/components';
import { theme } from '@/ui/tokens';

type Tab = 'cast' | 'reviews' | 'videos' | 'details' | 'seasons';

/**
 * The title page (screens.md §6), rebuilt after the founder's device test.
 *
 * What that test rejected, and what replaced it:
 *
 *   - genre pills floating over the poster. They are metadata, not artwork, and
 *     putting them on the hero made them compete with the one image on the screen.
 *     They now sit under the description, in neutral chips, where genre is a fact
 *     among facts.
 *   - initials-only cast as the intended state. `CastStrip` renders TMDB portraits
 *     and falls back to initials, rather than treating the fallback as the design.
 *   - a Reviews tab that was one person's private note relabelled. Notes are social
 *     content now, and they have a section of their own that says what they are.
 *   - a duplicated Rank affordance — a button beside a badge, both doing the same
 *     thing. The badge is the control.
 *
 * The hero is the app's one full-bleed surface and the score badge one of two
 * chromatic elements permitted on a content surface (design-system.md §1). Both
 * exceptions are spent here on purpose.
 */
export default function TitleScreen() {
  /**
   * The title, and — when the reader arrived from something a friend sent them — who
   * sent it and when.
   *
   * Carried in the link rather than looked up, because the fact belongs to the
   * *navigation* and not to the title: the same film opened from search is not
   * "recommended by Ada", and a query against `recommendations_to_me` on every title
   * page would be a round trip to answer a question only one route ever asks.
   */
  const { id, recBy, recAt } = useLocalSearchParams<{
    id: string;
    recBy?: string;
    recAt?: string;
  }>();
  const profile = useCurrentProfile();
  const queryClient = useQueryClient();
  const router = useRouter();
  const hasId = Boolean(id);
  const [watchlistBusy, setWatchlistBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  // Null until the reader picks one, so the default is whatever the tab row leads with
  // rather than a name fixed before the title is known. It was `'cast'`, which meant a
  // series settled on Cast the moment its credits arrived — after briefly showing the
  // seasons, because the fallback below had nothing else to choose while cast was empty.
  // A page that changes tab by itself a second after opening is worse than one that
  // opens on the wrong tab.
  const [tab, setTab] = useState<Tab | null>(null);
  const [loggingTitle, setLoggingTitle] = useState<LoggableTitle | null>(null);
  /**
   * The title the open ranking is about, and what it scored — the two halves of
   * returning to the log sheet once the comparisons are done.
   *
   * `loggingTitle` is cleared at the handoff, because screens.md §4 wants one continuous
   * motion and two stacked sheets is the opposite of that. So the `LoggableTitle` is
   * kept here across it, and `placement` carries the number the session produced rather
   * than making the sheet re-query for it.
   */
  const [rankedTitle, setRankedTitle] = useState<LoggableTitle | null>(null);
  const [placement, setPlacement] = useState<PostRank | null>(null);
  /**
   * Which door the log sheet was opened through, which decides how a *new* note
   * starts out. "Write a review" means publish; everything else means a private note
   * until the reader says otherwise. A note that already exists ignores this entirely.
   */
  const [logIntent, setLogIntent] = useState<'note' | 'review'>('note');
  /** Which composer the log sheet should already be showing when it appears, if any. */
  const [openWriting, setOpenWriting] = useState<'public' | 'private' | null>(null);
  const [rankingSubject, setRankingSubject] = useState<RankingSubject | null>(null);
  // Top by default, which is the founder's choice: a first-time reader wants the
  // review other people found worth reacting to, not the one written most recently.
  const [reviewSort, setReviewSort] = useState<ReviewSort>('top');
  const [recommending, setRecommending] = useState(false);
  /** The Ranked control's menu: change the rating, drop it, or remove the title. */
  const [managing, setManaging] = useState(false);
  /** Whom this title was last recommended to, which is the confirmation. */
  const [recommendedTo, setRecommendedTo] = useState<string | null>(null);

  /**
   * The catalogue row, and only that.
   *
   * Split from the viewer's own state on 2026-08-16. They were one `Promise.all`
   * that rethrew whichever error came back first, so a single missing column in
   * `user_media` — a backend one migration behind the client — took the whole page
   * down to "Could not load this title" for a film the catalogue had perfectly well.
   * Two independent facts were sharing one failure mode.
   *
   * This one is genuinely fatal: with no title there is no page.
   */
  const {
    data: titleRow,
    isPending,
    isError,
    error,
    refetch,
  } = useQuery({
    queryKey: queryKeys.title(id ?? ''),
    enabled: hasId,
    queryFn: async () => {
      const { data, error: titleError } = await supabase
        .from('media_items')
        .select(
          // The parent's artwork comes with it: a season has no backdrop of its own
          // (TMDB publishes none) and borrows the series' — see `lib/hero.ts`.
          'id, kind, title, season_number, release_date, runtime_minutes, overview, poster_path, backdrop_path, genres, provenance, tmdb_id, original_language, certification, parent:parent_id(id, title, poster_path, backdrop_path, genres, original_language)',
        )
        .eq('id', id ?? '')
        .single();
      if (titleError) throw titleError;
      return data;
    },
  });

  /**
   * What this viewer has already done with it: bucket, position, watchlist.
   *
   * Deliberately separate and deliberately non-fatal. Losing it costs the score
   * badge, the watch date and the watchlist state; it does not cost the film.
   */
  const personal = useQuery({
    queryKey: [...queryKeys.title(id ?? ''), 'personal', profile.id],
    enabled: hasId,
    queryFn: async () => {
      const [logged, ranked, watchlist] = await Promise.all([
        supabase
          .from('user_media')
          // `note_visibility` since the Ranked menu had to say Edit *review* or Edit
          // *private note*: one column stores both, and the menu cannot name the right
          // one without it. `useLogState` has selected it since notes became social.
          .select('bucket, watched_on, note, note_has_spoilers, note_visibility')
          .eq('user_id', profile.id)
          .eq('media_item_id', id ?? '')
          .maybeSingle(),
        supabase
          .from('rankings')
          .select('position, category, bucket')
          .eq('user_id', profile.id)
          .eq('media_item_id', id ?? '')
          .maybeSingle(),
        supabase
          .from('watchlist')
          .select('media_item_id')
          .eq('user_id', profile.id)
          .eq('media_item_id', id ?? '')
          .maybeSingle(),
      ]);

      if (logged.error) throw logged.error;
      if (ranked.error) throw ranked.error;
      if (watchlist.error) throw watchlist.error;
      return { logged: logged.data, ranked: ranked.data, watchlist: watchlist.data };
    },
  });

  const data = {
    title: titleRow,
    logged: personal.data?.logged ?? null,
    ranked: personal.data?.ranked ?? null,
    watchlist: personal.data?.watchlist ?? null,
  };

  const titleId = data?.title?.id ?? null;
  const credits = useCredits(titleId);
  const seasons = useSeasons(data?.title?.kind === 'series' ? data.title.id : null);
  const videos = useTitleVideos(titleId);
  /**
   * Reviews are Bingd's own public Notes on this exact title.
   *
   * What this replaced fetched TMDB's reviews from a `media_cache` facet. They were
   * labelled honestly and they were still another site's members writing about a film,
   * which is the wrong content for a tab called Reviews on a social product. The
   * founder's correction moves the tab to Bingd's own, and the alternative —
   * relabelling somebody else's user-generated content as critic writing — was never
   * on the table.
   *
   * Not fetched for a series, which cannot be ranked and so cannot be reviewed.
   */
  const reviews = useTitleReviews(data?.title?.kind === 'series' ? null : titleId, reviewSort);
  const community = useCommunityScore(titleId, profile.id);
  const following = useFollowingScore(titleId, profile.id);
  const watched = useWatched(profile.id);
  const companions = useCompanions(profile.id, titleId);
  // Seeded rows arrive with no artwork, overview or credits. Opening the screen is
  // what fetches them, unless the bulk pass got there first.
  // The second condition is about the Phase E deployment rather than about this title:
  // a null videos facet means nobody has asked TMDB about its trailers since the
  // adapter learned to store them, which is true of every row enriched before
  // 2026-08-17 and of nothing else. `useTitleVideos` explains why null and empty are
  // different answers.
  const { enriching } = useTitleEnrichment(data?.title ?? null, videos.data === null);
  // The score is derived from the band, so this needs the whole category's
  // bucket counts — not just this title's row (ranking.md §11).
  const rankCategory: RankingCategory =
    data?.ranked?.category === 'tv_seasons' ? 'tv_seasons' : 'movies';
  const titleScore = useTitleScore(profile.id, rankCategory, data?.ranked ?? null);
  /**
   * The ranked list this title sits in, for the hero's one rank line.
   *
   * Already cached — Collection and Profile read the same key — so on the ordinary
   * path this costs nothing, and it is what lets the rank context be derived rather
   * than fetched. Only fetched at all once we know the title is ranked.
   */
  const rankedList = useRankedCollection(profile.id, rankCategory);

  /**
   * The viewer's ranked seasons, for the series page only.
   *
   * A series page's real question is "where am I up to", and the answer is which of
   * these seasons this person has already ranked. Fetched only for a series, so a film
   * page does not pay for a list it has no use for.
   */
  const isSeriesTitle = data?.title?.kind === 'series';
  const rankedSeasons = useRankedCollection(profile.id, 'tv_seasons', {
    enabled: isSeriesTitle,
  });
  const rankedSeasonIds = useMemo(
    () => new Set((rankedSeasons.data ?? []).map((entry) => entry.mediaItemId)),
    [rankedSeasons.data],
  );

  // Above the early returns, because the empty and loading states below are also
  // renders and a hook cannot be called from only some of them.
  const header = useDetailHeader();

  const cast = useMemo(
    () =>
      (credits.data?.cast ?? []).map((person) => ({
        id: person.id,
        name: person.name,
        character: person.character,
        avatarUri: profileUri(person.profilePath),
      })),
    [credits.data],
  );

  if (!hasId) {
    return (
      <Screen includeBottomInset>
        <EmptyState kind="nothingMatches" title="Title not found" body="This link is incomplete." />
      </Screen>
    );
  }

  // Not a skeleton. A list has a knowable shape before its data arrives; this
  // page's height depends on whether there is a backdrop, an overview, a cast,
  // seasons — so a skeleton here would guess wrong and relayout anyway.
  if (isPending) {
    return (
      <Screen includeBottomInset>
        <LoadingScreen />
      </Screen>
    );
  }

  if (isError || !data?.title) {
    return (
      <Screen includeBottomInset>
        <EmptyState
          kind="couldNotLoad"
          title="Could not load this title"
          // The user gets the sentence they can act on; a developer gets the
          // dependency that actually failed. "Check your connection" was the only
          // thing this ever said, and it was wrong every time the cause was a
          // backend one migration behind the client — which is a connection that
          // is working perfectly.
          body={diagnose(error) ?? 'Check your connection and try again.'}
          action={{ label: 'Try again', onPress: () => void refetch() }}
        />
      </Screen>
    );
  }

  const title = data.title;
  const parent = Array.isArray(title.parent) ? title.parent[0] : title.parent;
  /**
   * The genres and language to describe this title with.
   *
   * A season carries neither of its own — TMDB publishes both on the series and
   * `tmdb_upsert_seasons` writes neither — so before this the genre pills were absent on
   * every season page, Details said nothing under Language, and the hero's rank line
   * could never read "#3 in Drama" for television. The show's are the season's.
   * (`lib/media-metadata.ts`.)
   */
  const descriptive = resolveMetadata({
    kind: title.kind,
    genres: title.genres,
    original_language: title.original_language,
    parent: title.parent ?? null,
  });
  // A season borrows its series' key art, because TMDB publishes no season backdrop
  // and the page was rendering its collapsed band for every one of them.
  const hero = heroArtwork({
    backdropPath: title.backdrop_path,
    posterPath: title.poster_path,
    parentBackdropPath: parent?.backdrop_path ?? null,
    parentPosterPath: parent?.poster_path ?? null,
  });
  // The page shows the series' own name in the hierarchy above the season, so the
  // heading itself stays short: "Season 2", under "Parks and Recreation".
  const displayTitle = compactName(
    {
      kind: title.kind,
      title: title.title,
      seriesTitle: parent?.title ?? null,
      seasonNumber: title.season_number ?? null,
    },
    { parentIsVisible: true },
  );
  const isWatchlisted = Boolean(data.watchlist);
  const watchedDate = data.logged?.watched_on
    ? new Date(`${data.logged.watched_on}T00:00:00Z`).toLocaleDateString(undefined, {
        timeZone: 'UTC',
        day: 'numeric',
        month: 'short',
        year: 'numeric',
      })
    : null;
  /**
   * Which of the two the writing on this title currently is, or neither.
   *
   * One column stores both, so these are mutually exclusive by construction and the
   * Ranked menu names the state it is actually in rather than offering two Adds for one
   * slot. Both false while the read is in flight, which is the safe way round: the menu
   * says Write rather than Edit, and Write on an existing note opens it for editing
   * anyway — the sheet resolves visibility from what is stored, not from which door was
   * used.
   */
  const noteText = (data.logged?.note ?? '').trim();
  const hasReview = Boolean(noteText) && data.logged?.note_visibility === 'public';
  const hasPrivateNote = Boolean(noteText) && data.logged?.note_visibility !== 'public';

  /** The band this title is already in, in the chips' spelling. Null until the read lands. */
  const rankedBucket = data.ranked?.bucket ? (BUCKET_IDS[data.ranked.bucket] ?? null) : null;

  const rankCategoryLabel = data.ranked?.category === 'tv_seasons' ? 'TV seasons' : 'Movies';
  // One line only, chosen by the founder's rule: top ten overall, else the
  // strongest category placement. Derived from rows already cached.
  const heroRank = data.ranked
    ? heroRankFor(title.id, rankedList.data ?? [], rankCategory, languageName)
    : null;
  const { score, total } = titleScore;
  const rankable = title.kind === 'movie' || title.kind === 'season';
  const isSeries = title.kind === 'series';
  const isSeason = title.kind === 'season';
  /** "Recommended by Ada · 2d ago", or nothing at all. */
  const recommendedBy = recBy
    ? `Recommended by ${recBy}${recAt ? ` · ${relativeTime(recAt)}` : ''}`
    : null;
  const year = yearOf(title.release_date);

  // Certification first. It is the fact somebody scans for before deciding whether to put
  // a film on, and TMDB only started supplying it here on 2026-08-17 — before that the
  // line began with a runtime.
  const metaLine = [
    title.certification,
    title.runtime_minutes ? `${title.runtime_minutes}m` : null,
    credits.data?.director,
  ]
    .filter(Boolean)
    .join(' · ');

  // A tab whose content does not exist is not rendered. An always-empty tab is
  // worse than a missing one: it invites a tap that leads nowhere. Videos is here
  // for the same reason it is in the schema — the day the adapter is redeployed the
  // tab appears by itself, and until then it does not pretend to.
  const tabs = [
    /**
     * Seasons first, and first only for a series — where it is not one section among
     * several but the entire point of the page.
     *
     * A series cannot be ranked (AD-1), so everything a reader came to do lives one
     * level down. It used to sit last, after Cast, Videos and Details, which meant a
     * series opened on Cast and the only route to the rankable unit was a tab at the
     * end of a row. That is the founder's dead-end report: not that the flow was
     * missing, but that it was the least prominent thing on a page that has nothing
     * else to offer.
     *
     * Unlike every other tab here it is rendered even when its list is empty. The rule
     * against permanently-empty tabs is about tabs that *may* have nothing — a film
     * with no trailer. A series always has seasons; an empty list means they have not
     * been fetched yet, and the honest thing is to say which of those it is rather than
     * to remove the page's only exit.
     */
    ...(isSeries ? [{ id: 'seasons' as const, label: 'Seasons' }] : []),
    ...(cast.length ? [{ id: 'cast' as const, label: 'Cast' }] : []),
    /**
     * Reviews is **always** present, unlike Cast and Videos.
     *
     * The rule against permanently-empty tabs is about a tab that can only ever have
     * nothing — a film TMDB publishes no trailer for. Reviews can always have
     * something, because the reader can write the first one, and its empty state is
     * the invitation to. Removing it until somebody else has written would mean the
     * only way to leave the first review of a film is to already have left it.
     *
     * A series is the exception and is excluded below: a series cannot be ranked, so
     * nobody can have a score to review it with.
     */
    ...(isSeries ? [] : [{ id: 'reviews' as const, label: 'Reviews' }]),
    ...(videos.data?.length ? [{ id: 'videos' as const, label: 'Videos' }] : []),
    { id: 'details' as const, label: 'Details' },
  ];
  // The chosen tab may not exist for this title — a film has no Seasons —
  // so it falls back rather than rendering nothing under a live tab row.
  const activeTab = tabs.some((option) => option.id === tab) ? tab : tabs[0]?.id;

  /**
   * This title as the log sheet wants it.
   *
   * It was built inline inside `openLog`, and Rank again needs the same object to hand
   * back to the post-rank sheet once the comparisons finish — so it is a value rather
   * than something two call sites each assemble from six fields.
   */
  const loggable: LoggableTitle = {
    id: title.id,
    title: title.title,
    year,
    posterUri: posterUri(title.poster_path, 'card'),
    kind: title.kind,
    seriesTitle: parent?.title ?? null,
    seasonNumber: title.season_number ?? null,
  };

  const openLog = (
    intent: 'note' | 'review' = 'note',
    // Set by the Ranked menu's two writing rows, which name a piece of writing and so
    // should land the reader inside it rather than in a sheet where they have to find
    // the row again. Null everywhere else, which is the sheet's ordinary behaviour.
    writing: 'public' | 'private' | null = null,
  ) => {
    if (!rankable) return;
    setActionError(null);
    setLogIntent(intent);
    setOpenWriting(writing);
    setPlacement(null);
    setLoggingTitle(loggable);
  };

  const toggleWatchlist = async () => {
    if (watchlistBusy) return;
    setWatchlistBusy(true);
    setActionError(null);
    const present = !isWatchlisted;
    const result = await setWatchlist({
      operationId: newOperationId(),
      mediaItemId: title.id,
      present,
    });
    setWatchlistBusy(false);

    // Additions only, and only on `ok` — the same rule as the other three bookmarks.
    if (present && result.outcome === 'ok') {
      track({ name: 'watchlist_added', props: { surface: 'title' } });
    }

    // Reconciled on an unknown outcome as well as on success — the same rule the other
    // three bookmark surfaces follow (`lib/write-outcome.ts`). Independent review 21e.
    if (mustReconcile(result)) {
      await Promise.all([
        // The watchlist itself and Queue Dragon, which counts it (collection/invalidate.ts).
        invalidateAfterWatchlistChange(queryClient, profile.id),
        queryClient.invalidateQueries({ queryKey: queryKeys.title(id ?? '') }),
        queryClient.invalidateQueries({ queryKey: queryKeys.collection(profile.id) }),
      ]);
    }

    if (result.outcome === 'failed') {
      setActionError(result.message);
      Alert.alert('Could not update watchlist', result.message);
      return;
    }
  };

  const afterCollectionChange = () =>
    invalidateAfterCollectionChange(queryClient, profile.id, title.id, {
      category: rankCategory,
    });

  /**
   * Removes the title from the collection, rating and all.
   *
   * Confirmed, because this one genuinely destroys things the person wrote: the watch
   * date, the note, the position. The alert names what goes rather than asking "are you
   * sure", which is a question nobody can answer without being told the consequence.
   *
   * The activity goes too, as of `20260818000100`, and the reactions and comments on it
   * are still named. Review 19 asked for that and it is right: the cascade reaches other
   * people's writing, and a consequence that falls on somebody who is not in the room is
   * exactly the sort a confirmation exists to state.
   *
   * **Shortened on founder review, and nothing was dropped.** It was one paragraph of
   * four clauses that read as a wall at the moment somebody is trying to make a
   * decision. It is now two sentences: what goes, then who else it touches. Every
   * consequence the old copy listed is still listed — rating, watch date, writing,
   * activity, reactions, comments, and that you can log it again — and the second
   * sentence is separate because it is the one about other people, which is the half a
   * reader is least likely to have thought of.
   *
   * The copy stays plain and serious. This is the one place in the app the playful
   * voice does not go, and the deletion behaviour behind it is untouched.
   */
  const confirmRemoval = () => {
    setManaging(false);
    Alert.alert(
      `Remove ${displayTitle ?? title.title} from your collection?`,
      'This removes your rating, watch date, review or private note, and related activity. You can log it again later.\n\nIt also removes any reactions and comments on that activity.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Remove',
          style: 'destructive',
          onPress: () => {
            void (async () => {
              setActionError(null);
              const result = await removeFromCollection({
                operationId: newOperationId(),
                mediaItemId: title.id,
                wasRanked: Boolean(data.ranked),
              });

              // Removal is two writes with a middle, and `changed` says either that the
              // first one landed or that the second one's outcome is unknown: the ranking
              // may be gone even though the title is still logged. Refreshing on the way
              // out of a failure is the only way the screen agrees with the database
              // (`collection/writes.ts`). Reviews 21c, 21d and 21e.
              if (mustReconcile(result)) afterCollectionChange();

              if (result.outcome === 'failed') {
                setActionError(result.message);
                Alert.alert('Could not remove this', result.message);
                return;
              }
            })();
          },
        },
      ],
    );
  };

  return (
    <Screen includeBottomInset edges={[]}>
      <Stack.Screen
        options={{
          title: title.title,
          headerShown: true,
          // Transparent, and transparent in both states. Toggling it once the title
          // appears would change the content inset and jog the whole page at exactly
          // the moment the reader is looking at it, so the opaque ground arrives as a
          // background view instead. Without transparency at all, the app's one
          // full-bleed image would start below a solid bar and not be full-bleed.
          headerTransparent: true,
          // Empty until the heading below has scrolled under the bar. See
          // `useDetailHeader` for why both detail routes now behave this way.
          headerTitle: header.revealed
            ? () => (
                <DetailHeaderTitle
                  // The same pair the heading shows, in the same relationship: a season
                  // is "Season 2" under "Parks and Recreation", never the flattened
                  // "Parks and Recreation — Season 2", which would not fit a bar and
                  // would say the series name twice on the way past.
                  title={displayTitle ?? title.title}
                  subtitle={parent?.title ?? null}
                />
              )
            : '',
          headerBackground: header.revealed ? () => <DetailHeaderBackground /> : undefined,
        }}
      />
      <ScrollView
        contentContainerStyle={styles.content}
        onScroll={header.onScroll}
        scrollEventThrottle={header.scrollEventThrottle}
        // The Seasons empty state has said "pull down to try again in a moment"
        // since the series redesign, and until now that was a gesture the app did
        // not have. Copy that names a gesture is a promise; this is the gesture.
        refreshControl={
          <RefreshControl
            refreshing={seasons.isRefetching || personal.isRefetching}
            onRefresh={() => {
              void refetch();
              void seasons.refetch();
              void personal.refetch();
            }}
            tintColor={theme.semantic.action}
            colors={[theme.semantic.action]}
          />
        }
      >
        <View>
          <TitleHero
            uri={hero.uri}
            blurred={hero.treatment === 'poster'}
            collapsedHeight={HERO_COLLAPSED}
          />
          {/* Who sent this and how long ago, over the artwork they sent it about.

              A rounded callout rather than a line of copy under the title, because it is
              not a fact about the film — it is the reason this particular person is
              looking at it, and it stops being true the moment they arrive any other way.
              Solid rather than translucent: legibility over a photograph cannot depend on
              what the photograph happens to be.

              Anchored above the poster rather than at the top of the hero, which keeps it
              clear of the transparent navigation bar without having to guess at its
              height on a device this code cannot measure.

              Only where there *is* artwork. The collapsed band is 96pt and the poster
              rises the same 96 into it, so a title with no backdrop has no hero to
              overlay — an absolute callout there would sit on the poster or above the
              screen. That case gets the same callout inline, under the heading. */}
          {recommendedBy && hero.uri ? (
            <RecommendedCallout label={recommendedBy} overlay />
          ) : null}
        </View>

        {/* The poster rises into the hero and the score sits opposite it, so the
            two anchor the same band rather than stacking. Negative margin rather
            than absolute positioning, so everything below still flows from it. */}
        <View style={styles.identity}>
          <View style={styles.posterFrame}>
            <Poster uri={posterUri(title.poster_path, 'card')} title={title.title} size="lg" />
          </View>
          {/* My relationship to this title, and nothing else. The community's
              number moved to its own section further down — beside this one the two
              were the same shape at the same weight, and the reader's own score is
              what this half of the page is for. */}
          <View style={styles.scoreColumn}>
            <PersonalState
              score={score}
              bucket={data.ranked?.bucket ?? null}
              ordinal={heroRank?.label ?? null}
              onPress={() => openLog()}
              // Ranked is a fact with more than one thing to do to it, so it opens a menu
              // rather than jumping straight back into the comparison. Long press was
              // considered and rejected: an interaction nobody can see is not a way out of
              // a mistake somebody is trying to undo.
              onPressRanked={() => setManaging(true)}
              rankable={rankable}
            />
          </View>
        </View>

        {/* The identity, for the header's purposes: everything down to and including
            the title itself. Once its bottom edge passes under the bar, the bar says
            the title instead. */}
        <View style={styles.heading} onLayout={header.onIdentityLayout}>
          {/* A season says which show it belongs to, above its own name. The feed
              writes that as one string because it has no room; here there is a
              hierarchy to put it in. */}
          {parent?.title ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`${parent.title}, the series this belongs to`}
              onPress={() => router.push(`/title/${parent.id}`)}
            >
              <Text variant="callout" tone="action" numberOfLines={1}>
                {parent.title}
              </Text>
            </Pressable>
          ) : null}
          {/* The year sits *inside* the heading, muted, rather than starting the line
              below it. The founder's hierarchy is "The Dark Tower  2017" on one line
              and "PG-13 · 95m · Nikolaj Arcel" on the next — which separates what the
              thing is called from what it is, instead of running a year, a runtime and
              a director together as one undifferentiated string. */}
          {/* "Season 1, 2023" for a season, under the show’s own name on the line above.
              The em dash form the log sheet uses — "Parks and Recreation — Season 2" — is
              for surfaces with one line to say the whole name in. Here there is a
              hierarchy to put it in, and a comma is what joins a season to its year in
              every other place anybody writes one down. */}
          <Text variant="title1">
            {displayTitle ?? title.title}
            {year ? (
              <Text variant="title1" tone="tertiary">
                {isSeason ? `, ${year}` : `  ${year}`}
              </Text>
            ) : null}
          </Text>
          {/* Built before it is rendered, because all three parts can be missing at once
              — an obscure title with no certification, no runtime and no director credit
              — and an empty `Text` is not nothing on screen. It is a line box with the
              footnote's height, which reads as a gap under the title and is the same
              defect as the dead score space the founder's corrections removed from the
              hero. Independent review 17e. */}
          {metaLine ? (
            <Text testID="title-meta" variant="footnote" tone="secondary">
              {metaLine}
            </Text>
          ) : null}
          {/* The no-artwork case. Same object, laid out in the flow rather than over a
              hero that is not there. */}
          {recommendedBy && !hero.uri ? <RecommendedCallout label={recommendedBy} /> : null}
        </View>

        {watchedDate || companions.data?.length ? (
          <View style={styles.block}>
            <Text variant="footnote" tone="secondary">
              {[
                watchedDate ? `Watched ${watchedDate}` : null,
                companions.data?.length
                  ? `with ${companions.data.map((person) => person.name).join(', ')}`
                  : null,
              ]
                .filter(Boolean)
                .join(' ')}
            </Text>
          </View>
        ) : null}

        {/* Above the description, and still never over the artwork. The founder's
            order is metadata → genres → description, which reads outward from what the
            thing *is* to what it is *about*; underneath the description they were a
            footnote to a paragraph nobody had finished reading. */}
        {descriptive.genres.length ? (
          <View style={styles.pills}>
            {descriptive.genres.slice(0, 5).map((genre: string) => (
              <Chip key={genre} label={genre} />
            ))}
          </View>
        ) : null}

        {title.overview ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={expanded ? 'Collapse description' : 'Expand description'}
            onPress={() => setExpanded((open) => !open)}
            style={styles.block}
          >
            <Text variant="body" numberOfLines={expanded ? undefined : 3}>
              {title.overview}
            </Text>
            {/* No "less". Once it is open the whole thing is visible and the
                control has nothing left to promise. */}
            {expanded ? null : (
              <Text variant="callout" tone="action">
                more
              </Text>
            )}
          </Pressable>
        ) : null}

        {/* A deliberate row rather than two glyphs floating under the title.
            Rank is not here — it belongs opposite the poster, with the score it
            changes, and a second Rank affordance is the duplication the founder
            already rejected once. */}
        <View style={styles.actionRow}>
          <RowAction
            icon={isWatchlisted ? 'bookmark' : 'bookmark-outline'}
            label={isWatchlisted ? 'Saved' : 'Watchlist'}
            accessibilityLabel={
              isWatchlisted ? `Remove ${title.title} from your watchlist` : `Add ${title.title} to your watchlist`
            }
            selected={isWatchlisted}
            onPress={() => void toggleWatchlist()}
            disabled={watchlistBusy}
          />
          {/* Recommend is a first-class Bingd action: it is what somebody does with a
              title they already have an opinion about, and it goes to one named person
              rather than to an address book. A series has no Recommend, for the same
              reason it has no Rank — it is not a thing anybody watched (PRD §10), which
              leaves a series page with Watchlist alone. Season pages keep both. */}
          {rankable ? (
            <RowAction
              icon="paper-plane-outline"
              label="Recommend"
              accessibilityLabel={`Recommend ${title.title} to a friend`}
              onPress={() => {
                setActionError(null);
                setRecommendedTo(null);
                setRecommending(true);
              }}
            />
          ) : null}
          {/* There is no third control. Share used to sit here and it was the one that
              pushed the row off the edge of a narrow Android screen: three labelled chips
              do not fit at 360pt with the gutter this page uses. It has not been dropped.
              The Recommend sheet ends in "Share off Bingd", which is the same native
              share with the reader's invite link attached. One act, one door. */}
        </View>

        {actionError ? (
          <View style={styles.block}>
            <Text variant="footnote" tone="action">
              {actionError}
            </Text>
          </View>
        ) : null}

        {/* The confirmation, on the page the reader is still looking at rather than
            in an alert they have to dismiss. It names the person, because "Sent"
            alone leaves them checking. */}
        {recommendedTo ? (
          <View style={styles.block}>
            <Text testID="recommend-confirmation" variant="footnote" tone="secondary">
              {`Recommended to ${recommendedTo}`}
            </Text>
          </View>
        ) : null}

        {/* The film is on screen and the viewer's own state is not. Said once,
            quietly, with a way back — rather than either failing the whole page
            or pretending the score badge means "unranked". */}
        {personal.isError ? (
          <View style={styles.block}>
            <Text variant="footnote" tone="secondary">
              {diagnose(personal.error) ?? 'Your rating and watchlist state could not be loaded.'}
            </Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Retry loading your rating"
              onPress={() => void personal.refetch()}
              hitSlop={theme.space[2]}
            >
              <Text variant="callout" tone="action">
                Try again
              </Text>
            </Pressable>
          </View>
        ) : null}

        {/* **Above the tabs, and never inside them.** The founder's correction: scores
            are core Bingd data, and putting them below a tab row meant they appeared
            and disappeared as somebody looked at the cast. The page order is fixed now
            — hero, metadata, genres, description, actions, scores, tabs — so a reader
            scrolling to the number finds it in the same place every time.

            A series has no aggregate of its own, because it cannot be ranked
            (PRD §10), so it gets no section rather than a permanent "No ratings yet".

            **The reader's own score is not in here.** It is in the hero, opposite the
            poster, with the rank context and the Ranked control beside it. It led this
            section as well until 2026-08-18, which put the same number on the page
            twice and made the second copy the weaker one — no rank line, no way to
            change the rating. Founder correction. */}
        {!isSeries ? (
          <ScoresSection
            // Everybody's, then the reader's own people — the founder's order from the
            // Preview pass. Both units are always drawn: a grey circle and "Not enough
            // ratings" is a real answer, and a unit that appears when the data does is
            // a page that moves under the reader.
            bingd={{
              score: community.data?.score ?? null,
              ratingCount: community.data?.ratingCount ?? 0,
            }}
            following={{
              score: following.data?.score ?? null,
              ratingCount: following.data?.ratingCount ?? 0,
            }}
          />
        ) : null}

        <View style={styles.tabs}>
          <SegmentedTabs
            options={tabs}
            value={activeTab ?? 'details'}
            onChange={(next) => setTab(next)}
          />
        </View>

        {activeTab === 'cast' ? (
          <CastStrip cast={cast} onPressMember={(member) => router.push(`/person/${member.id}`)} />
        ) : null}

        {activeTab === 'videos' && videos.data?.length ? (
          <View style={styles.details}>
            {videos.data.map((video) => (
              <Pressable
                key={video.id}
                accessibilityRole="link"
                accessibilityLabel={`Play ${video.name} on YouTube`}
                onPress={() => {
                  const uri = videoUri(video.key);
                  if (uri) void Linking.openURL(uri);
                }}
                style={({ pressed }) => [styles.video, pressed && styles.pressed]}
              >
                <Ionicons
                  name="play-circle-outline"
                  size={theme.layout.icon.lg}
                  color={theme.semantic.action}
                />
                <View style={styles.videoCopy}>
                  <Text variant="callout" numberOfLines={1}>
                    {videoTitle(video)}
                  </Text>
                  {/* Where it plays and what kind of thing it is, in that order.
                      "Trailer" alone said neither: three rows reading "Trailer 1",
                      "Teaser", "Trailer" tell a reader nothing about which to tap. */}
                  <Text variant="caption" tone="tertiary">
                    {[SITE_LABEL[video.site] ?? video.site, video.type].filter(Boolean).join(' · ')}
                  </Text>
                </View>
              </Pressable>
            ))}
          </View>
        ) : null}

        {activeTab === 'reviews' ? (
          <TitleReviews
            reviews={reviews.data ?? []}
            loading={reviews.isPending}
            sort={reviewSort}
            onChangeSort={setReviewSort}
            // Against this viewer's watched set and this exact media item: having seen
            // Season 1 does not unmask Season 2.
            maskedFor={(review) =>
              shouldMask({
                hasSpoilers: review.hasSpoilers,
                mediaItemId: title.id,
                viewerId: profile.id,
                authorId: review.userId,
                watched: watched.data,
              })
            }
            onPressAuthor={(handle) => router.push(`/u/${handle}`)}
            viewerRanked={Boolean(data.ranked)}
            viewerHasReview={(reviews.data ?? []).some((review) => review.userId === profile.id)}
            // One composer. A note has always been written in the log sheet, where the
            // spoiler flag and the visibility are chosen beside it; a second one here
            // would be a second content model wearing a different button.
            onWrite={() => openLog('review')}
            noun={title.kind === 'season' ? 'season' : 'movie'}
            // So the reporting control is absent from the viewer's own review, which
            // the server would refuse anyway.
            viewerId={profile.id}
          />
        ) : null}

        {activeTab === 'details' ? (
          <View style={styles.details}>
            <Detail label="Released" value={formatDate(title.release_date)} />
            <Detail
              label="Runtime"
              value={title.runtime_minutes ? `${title.runtime_minutes} minutes` : null}
            />
            <Detail label="Genres" value={descriptive.genres.join(', ') || null} />
            <Detail label="Language" value={languageName(descriptive.language)} />
            <Detail label="Director" value={credits.data?.director ?? null} />
            {/* The ordinal with its denominator. The panel above shows the short
                form, which is the one people read; this is the one that says what
                it is two of (PRD §10). */}
            <Detail
              label="Your rank"
              value={
                data.ranked && total ? `#${data.ranked.position} of ${total} in ${rankCategoryLabel}` : null
              }
            />
          </View>
        ) : null}

        {activeTab === 'seasons' ? (
          seasons.data?.length ? (
            <View>
              {seasons.data.map((season) => (
                <TitleRow
                  key={season.id}
                  title={season.title}
                  year={yearOf(season.release_date)}
                  posterUri={posterUri(season.poster_path)}
                  // Not the word "Season" — the title beside it already reads
                  // "Season 2". What a returning reader wants from this list is where
                  // they are up to, so the row says whether they have ranked it.
                  secondary={rankedSeasonIds.has(season.id) ? 'Ranked' : 'Not ranked yet'}
                  onPress={() => router.push(`/title/${season.id}`)}
                />
              ))}
            </View>
          ) : seasons.isPending || enriching ? (
            <SkeletonRow count={3} />
          ) : (
            // A series with no seasons is a series nobody has looked up yet, not a
            // series without seasons. Saying so is better than an empty box, and far
            // better than removing the tab and leaving the page with no way onward.
            <EmptyState
              kind="nothingYet"
              compact
              title="Seasons are still loading"
              body="Pull down to try again in a moment."
            />
          )
        ) : null}

        <View style={styles.footer}>
          {enriching ? (
            <Text variant="caption" tone="tertiary">
              Fetching details…
            </Text>
          ) : null}
          {/* One of the two attribution slots TMDB's terms ask for. The full notice
              lives in Settings › About, which is the "About or Credits section" their
              FAQ names; this is the per-title source line from screens.md §6. */}
          {title.provenance === 'tmdb' ? (
            <Text variant="caption" tone="tertiary">
              Metadata from TMDB
            </Text>
          ) : null}
        </View>
      </ScrollView>

      <LogSheet
        title={loggingTitle}
        surface="title"
        noteIntent={logIntent}
        openWriting={openWriting}
        postRank={placement}
        onDone={() => {
          setLoggingTitle(null);
          setPlacement(null);
        }}
        onClose={() => {
          setLoggingTitle(null);
          setPlacement(null);
          setActionError(null);
        }}
        onRank={(bucket, mode) => {
          if (!loggingTitle) return;
          setRankingSubject({
            id: loggingTitle.id,
            title: loggingTitle.title,
            bucket,
            posterUri: loggingTitle.posterUri,
            mode,
          });
          setRankedTitle(loggingTitle);
          setPlacement(null);
          setLoggingTitle(null);
        }}
      />
      <RankingSheet
        subject={rankingSubject}
        onClose={() => setRankingSubject(null)}
        onRankAnother={() => setRankingSubject(null)}
        // Ranking is a subflow of logging, so it returns to the log rather than ending
        // at a number. The same sheet, on the same title, with the score at the top of
        // it — there is one implementation of "the rest of your log" and this is it.
        onFinishLog={(result) => {
          setRankingSubject(null);
          if (!rankedTitle) return;
          setLogIntent('note');
          setPlacement(result);
          setLoggingTitle(rankedTitle);
        }}
        surface="title"
      />
      {/* Mounted only while open, like every other sheet here: it seeds its own
          draft state on mount, and one that stayed mounted would keep a search
          somebody abandoned. */}
      {/**
        * The way back out of a ranking, and out of the collection.
        *
        * Both were unreachable before this: the only thing the Ranked chip did was
        * reopen the comparison, so an accidental ranking could be changed and never
        * undone, and a title logged by mistake stayed logged.
        *
        * **Two rows, since the founder's final pass. There is no "remove ranking".** It
        * was the middle row and it offered a state Bingd does not otherwise have: a
        * title sitting in somebody's collection with no position, permanently, by
        * choice. The product rule is that a title you keep is a title you have an
        * opinion about — the Unranked tab is a queue to get through, not a place to
        * park things — and an action whose whole purpose is to create a state the rest
        * of the app treats as unfinished is an action that should not be offered.
        *
        * So: change the rating if it was wrong, and remove it from the collection if it
        * should not be there. The second is the full escape hatch for an accidental log
        * and always was; what it costs over the old middle row is a confirmation and
        * the watch date, which is the right price for the rarer intention.
        *
        * **`rank_unrank` itself is untouched.** It is what `rank_rebucket` calls to move
        * a title between bands, and it is granted, tested and load-bearing. What has
        * gone is one row in one sheet.
        */}
      {managing ? (
        <Sheet
          visible
          onClose={() => setManaging(false)}
          label={`Options for ${displayTitle ?? title.title}`}
        >
          <View style={styles.menu}>
            {/**
              * **Three groups, because seven undifferentiated rows is a list rather than
              * a menu.**
              *
              * Your log is what you wrote about it, ranking is where it sits, collection
              * is whether you keep it at all — and the destructive one is last and on its
              * own, which is the only ordering that never puts Remove under a thumb
              * reaching for something else.
              */}
            <MenuGroup title="Your log" />
            {/**
              * **One field, two rows, and the label says which state it is in.**
              *
              * `user_media` holds one `note` under one `note_visibility`, so exactly one
              * of these two ever reads Edit. The other offers the conversion, named as
              * the act it performs rather than as "add" — writing already exists, and a
              * row that said Add would be promising a second piece of writing this
              * schema has nowhere to put.
              *
              * Publishing confirms; making something private does not. That asymmetry is
              * the log sheet's, and it is enforced there rather than duplicated here —
              * these rows open the sheet, and the sheet owns what a conversion costs.
              *
              * **The founder's device pass: every `value` in this menu is gone.**
              * `SheetRow` draws the label and the secondary sentence on one line, so at
              * the width of a phone each of the five explanations truncated — five rows
              * of clipped grey text under five clear labels, which is worse than no
              * explanation at all, because the reader can see that something was meant
              * to be said and cannot read it. The labels below carry their own meaning;
              * the sentences that did not fit are in this comment, where they are for
              * whoever changes the rows next rather than for somebody choosing one.
              */}
            <SheetRow
              icon="chatbubble-ellipses-outline"
              label={hasReview ? 'Edit review' : hasPrivateNote ? 'Share as a review' : 'Write review'}
              onPress={() => {
                setManaging(false);
                openLog('review', 'public');
              }}
            />
            <SheetRow
              icon="lock-closed-outline"
              label={
                hasPrivateNote
                  ? 'Edit private note'
                  : hasReview
                    ? 'Make it a private note'
                    : 'Add private note'
              }
              onPress={() => {
                setManaging(false);
                openLog('note', 'private');
              }}
            />

            <MenuGroup title="Ranking" />
            {/**
              * **Rank again means you watched it again.**
              *
              * That is the product definition (`docs/product/prd.md` §10), and it is why
              * this row is the one place in the app that declares a second viewing:
              * completing it writes exactly one new `title_ranked` activity, where
              * Change your rating below writes none.
              *
              * `rank_again` (20260825000200, re-signed 20260826000500) opens a
              * comparison session **over the position the title already has**. Nothing
              * the reader can see moves until they finish: close the sheet, lose the
              * network, kill the app, and the score, the band and the place in the list
              * are exactly where they were. The founder's device pass found the
              * opposite — the score vanished the moment this row was tapped — and that
              * was the server unranking before it opened the session.
              *
              * The client writer is `session.rankAgain`, reached by opening the ranking
              * sheet in `again` mode, which is the *only* way this app is allowed to do
              * it. Composing `rank_unrank` and `rank_start` here would be two calls with
              * a window between them in which the title has no position and no session.
              *
              * The bucket is passed straight through from `rankings.bucket`, so this row
              * decides no rating — it redoes the comparisons inside the band that is
              * already chosen.
              */}
            <SheetRow
              icon="repeat-outline"
              label="Rank again"
              onPress={
                rankedBucket
                  ? () => {
                      setManaging(false);
                      setActionError(null);
                      setRankedTitle(loggable);
                      setRankingSubject({
                        id: title.id,
                        title: title.title,
                        bucket: rankedBucket,
                        posterUri: posterUri(title.poster_path, 'card'),
                        mode: 'again',
                      });
                    }
                  : undefined
              }
              disabledReason={rankedBucket ? undefined : 'Loading'}
            />
            {/* The other half of the pair, and not a synonym for it: this changes the
                *band* — loved, fine, not for me — which is a correction to an opinion
                already recorded rather than a second viewing. It writes no new activity
                and it does not surrender the current position while it runs. */}
            <SheetRow
              icon="star-outline"
              label="Change your rating"
              onPress={() => {
                setManaging(false);
                openLog();
              }}
            />

            <MenuGroup title="Collection" />
            <SheetRow
              icon="trash-outline"
              label="Remove from collection"
              onPress={confirmRemoval}
            />
          </View>
        </Sheet>
      ) : null}
      {recommending ? (
        <RecommendSheet
          viewerId={profile.id}
          mediaItemId={title.id}
          kind={title.kind}
          title={displayTitle ?? title.title}
          seriesTitle={parent?.title ?? null}
          seasonNumber={title.season_number ?? null}
          onClose={() => setRecommending(false)}
          onSent={setRecommendedTo}
          surface="title"
        />
      ) : null}
    </Screen>
  );
}

/**
 * "Recommended by Ada · 2d ago", as an object rather than as a line of copy.
 *
 * It is not a fact about the film. It is the reason this particular person is looking
 * at it, and it stops being true the moment they arrive any other way — so it is drawn
 * as a callout that visibly sits *on* the page rather than as another metadata line
 * the page owns.
 *
 * Solid rather than translucent, because legibility over a photograph cannot depend on
 * what the photograph happens to be.
 */
function RecommendedCallout({ label, overlay = false }: { label: string; overlay?: boolean }) {
  return (
    <View
      pointerEvents="none"
      style={[styles.recommendedCallout, overlay && styles.recommendedOverlay]}
    >
      <Ionicons name="paper-plane" size={theme.layout.icon.sm} color={theme.semantic.action} />
      <Text variant="footnote" numberOfLines={1} style={styles.recommendedLabel}>
        {label}
      </Text>
    </View>
  );
}

/**
 * A heading inside an action sheet.
 *
 * The Ranked menu grew from two rows to five across three different kinds of act —
 * what you wrote, where it sits, whether you keep it — and five rows in one column
 * with no structure is a list you read rather than a menu you use. Deliberately not
 * `SectionHeader`: that one carries the page gutter and a `title3`, which inside a
 * sheet is the same size as the rows it is meant to be subordinate to.
 *
 * `header` rather than plain text, so a screen reader can jump between the groups
 * instead of hearing five sibling buttons.
 */
function MenuGroup({ title }: { title: string }) {
  return (
    <View style={styles.menuGroup} accessibilityRole="header">
      <Text variant="caption" tone="tertiary">
        {title.toUpperCase()}
      </Text>
    </View>
  );
}

/** Label above value, stacked, no rules — Apple TV's information layout. */
function Detail({ label, value }: { label: string; value: string | null }) {
  if (!value) return null;

  return (
    <View style={styles.detail}>
      <Text variant="caption" tone="tertiary">
        {label.toUpperCase()}
      </Text>
      <Text variant="body">{value}</Text>
    </View>
  );
}

/**
 * One action in the row under the description.
 *
 * Icon first with a word beside it, rather than a bare glyph. The bare version was
 * what made these read as floating: a bookmark on its own says nothing about whether
 * it is a state or a button, and "Saved" versus "Watchlist" is the whole difference
 * the control exists to show.
 */
function RowAction({
  icon,
  label,
  accessibilityLabel,
  onPress,
  disabled = false,
  selected,
}: {
  icon: React.ComponentProps<typeof Ionicons>['name'];
  label: string;
  accessibilityLabel: string;
  onPress: () => void;
  disabled?: boolean;
  selected?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ disabled, ...(selected === undefined ? {} : { selected }) }}
      onPress={onPress}
      disabled={disabled}
      hitSlop={theme.space[2]}
      style={({ pressed }) => [
        styles.rowAction,
        selected && styles.rowActionOn,
        (pressed || disabled) && styles.pressed,
      ]}
    >
      <Ionicons name={icon} size={theme.layout.icon.sm} color={theme.semantic.action} />
      <Text variant="callout" tone="action">
        {label}
      </Text>
    </Pressable>
  );
}


/**
 * Where a video plays, as a word rather than a hostname.
 *
 * A map rather than the raw value so an unrecognised site still renders — TMDB's `site`
 * is already a proper noun and the fallback is to print it.
 */
const SITE_LABEL: Record<string, string> = { YouTube: 'YouTube', Vimeo: 'Vimeo' };

/**
 * The name TMDB publishes, and what to do when it says nothing.
 *
 * A studio names its own uploads — "Official Trailer #2", "Final Trailer" — and those
 * are exactly what a reader wants. But TMDB also carries a great many named literally
 * "Trailer", "Teaser" or "Trailer 1", and the founder's screenshot was three rows
 * reading Trailer 1 / Teaser / Trailer, which tell a reader nothing about which to tap.
 *
 * So a name that is *only* the type, with or without a number, is replaced by one that
 * at least separates the studio's upload from the rest. Anything with real words in it
 * is left exactly as it was written: the fallback exists for the empty case, not to
 * improve on somebody's title.
 */
function videoTitle(video: { name: string; type: string; official: boolean }) {
  const name = video.name?.trim() ?? '';
  const generic = new RegExp(String.raw`^(official\s+)?${video.type}(\s*\d+)?$`, 'i');

  if (name && !generic.test(name)) return name;

  // The type's own casing, so a video already named "Official Trailer" comes back
  // spelled exactly as it arrived rather than re-cased for no reason — and one named
  // bare "Trailer" that TMDB marks official gains the word that distinguishes it from
  // the fan uploads beside it.
  return video.official ? `Official ${video.type}` : video.type;
}

function yearOf(date: string | null) {
  if (!date) return null;
  return Number(date.slice(0, 4));
}

function formatDate(date: string | null) {
  if (!date) return null;
  return new Date(`${date}T00:00:00Z`).toLocaleDateString(undefined, {
    timeZone: 'UTC',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
}

/** Tall enough that the poster still overlaps something when there is no
 *  backdrop, so the page does not become a different design. */
const HERO_COLLAPSED = 96;

/**
 * How far the poster rises into the hero.
 *
 * Raised from 64 with the taller hero. The founder's note was that the poster sat
 * "beneath a separate strip" rather than in the artwork, and at 64 against the old
 * 16:9 frame its top landed where the fade had already reached the page — so it
 * overlapped Paper, not an image. At 96 against the taller frame it sits on artwork
 * that is still visibly artwork, which is what makes the two read as one object.
 */
const POSTER_LIFT = 96;

const styles = StyleSheet.create({
  content: { paddingBottom: theme.space[10] },
  identity: {
    flexDirection: 'row',
    // Baselines, not centres: the poster is the dominant object and everything
    // beside it hangs from its lower edge, which is where the page resumes.
    alignItems: 'flex-end',
    gap: theme.space[4],
    paddingHorizontal: theme.layout.gutter,
    marginTop: -POSTER_LIFT,
  },
  /**
   * A Paper mat around the artwork, the way a print is framed.
   *
   * The poster straddles the hero's lower edge, and without this it reads as cut out
   * and dropped on — its own hairline is a millimetre of separation from whatever
   * happens to be behind it. Four points of the page's own colour, plus the shadow,
   * makes it an object sitting on the page rather than a hole in it.
   */
  posterFrame: {
    padding: theme.space[1],
    borderRadius: theme.radius.card + theme.space[1],
    backgroundColor: theme.surface.base,
    ...theme.elevation.e2,
  },
  // Sits in the poster's lower half, where the hero has already faded to Paper —
  // nothing legible may sit on artwork.
  /**
   * Sits in the poster's lower half, where the hero has already faded to Paper —
   * nothing legible may sit on artwork.
   *
   * `justifyContent: 'flex-end'` is what stops the unranked state leaving a tall empty
   * channel. The row aligns on the poster's baseline, so a short column now hangs from
   * the bottom of the band with the button beside the poster's lower edge, rather than
   * starting at the top and leaving the gap the founder's Ant-Man and Dark Tower
   * screenshots showed.
   */
  scoreColumn: { flex: 1, justifyContent: 'flex-end', paddingBottom: theme.space[3] },
  heading: {
    paddingHorizontal: theme.layout.gutter,
    paddingTop: theme.space[4],
    gap: theme.space[1],
  },
  /**
   * Wraps rather than overflows.
   *
   * Two chips fit on every width this app supports, and that is the design. The wrap is
   * the guard for the case the design cannot control: a reader at a large text size, on a
   * narrow device, in a language where "Watchlist" is two words. Without it the second
   * chip is simply cut off at the screen edge, which is what the founder found.
   */
  actionRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    columnGap: theme.space[3],
    rowGap: theme.space[2],
    paddingHorizontal: theme.layout.gutter,
    paddingTop: theme.space[4],
  },
  recommendedCallout: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space[2],
    paddingHorizontal: theme.space[3],
    paddingVertical: theme.space[2],
    marginTop: theme.space[2],
    borderRadius: theme.radius.control,
    backgroundColor: theme.surface.raised,
    ...theme.elevation.e1,
  },
  /**
   * On the hero, above the poster.
   *
   * `bottom` is measured from the hero's lower edge and clears the poster, which rises
   * `POSTER_LIFT` into it. Applied only where there is artwork to sit on: the collapsed
   * band is the same height as the lift, so there is nothing left to overlay.
   */
  recommendedOverlay: {
    position: 'absolute',
    left: theme.layout.gutter,
    right: theme.layout.gutter,
    bottom: POSTER_LIFT + theme.space[3],
    marginTop: 0,
  },
  // Takes the width the glyph leaves, so a long name truncates rather than pushing the
  // callout wider than the gutters allow.
  recommendedLabel: { flex: 1 },
  menu: { paddingBottom: theme.space[4], paddingTop: theme.space[2] },
  // Enough air above to separate the group from the rows before it, and none below:
  // the heading belongs to what follows it.
  menuGroup: {
    paddingHorizontal: theme.layout.gutter,
    paddingTop: theme.space[4],
    paddingBottom: theme.space[1],
  },
  rowAction: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space[2],
    minHeight: theme.layout.minTapTarget,
    paddingHorizontal: theme.space[4],
    borderRadius: theme.radius.control,
    borderWidth: StyleSheet.hairlineWidth * 2,
    borderColor: theme.border.hairline,
    backgroundColor: theme.surface.raised,
  },
  // Saved reads as a held state, so it takes the warm surface rather than a second
  // colour the palette does not have to spend.
  rowActionOn: { backgroundColor: theme.surface.sunken, borderColor: theme.semantic.action },
  block: {
    paddingHorizontal: theme.layout.gutter,
    paddingTop: theme.space[3],
    gap: theme.space[1],
  },
  pills: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: theme.space[2],
    paddingHorizontal: theme.layout.gutter,
    paddingTop: theme.space[3],
  },
  tabs: {
    marginTop: theme.space[5],
    borderTopWidth: StyleSheet.hairlineWidth * 2,
    borderTopColor: theme.border.hairline,
    paddingTop: theme.space[1],
    marginBottom: theme.space[2],
  },
  details: { paddingHorizontal: theme.layout.gutter, gap: theme.space[4] },
  detail: { gap: 2 },
  video: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space[3],
    minHeight: theme.layout.rowMinHeight,
  },
  videoCopy: { flex: 1, gap: 2 },
  section: { paddingTop: theme.space[6], gap: theme.space[2] },
  note: {
    paddingHorizontal: theme.layout.gutter,
    paddingVertical: theme.space[3],
    gap: theme.space[2],
    borderBottomWidth: StyleSheet.hairlineWidth * 2,
    borderBottomColor: theme.border.hairline,
  },
  noteHead: { flexDirection: 'row', alignItems: 'center', gap: theme.space[2] },
  footer: {
    paddingHorizontal: theme.layout.gutter,
    paddingTop: theme.space[6],
    gap: theme.space[1],
  },
  pressed: { opacity: 0.7 },
});