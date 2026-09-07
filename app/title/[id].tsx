import { Ionicons } from '@expo/vector-icons';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Stack, useLocalSearchParams, useRouter, type ErrorBoundaryProps } from 'expo-router';
import { useMemo, useState } from 'react';
import {
  Alert,
  Animated,
  Linking,
  Pressable,
  RefreshControl,
  StyleSheet,
  View,
  useWindowDimensions,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useCurrentProfile } from '@/features/auth';
import { useCelebrationHandoff } from '@/features/awards/celebration-queue';
import { LogSheet, type LoggableTitle, type PostRank } from '@/features/collection/LogSheet';
import { BUCKET_IDS } from '@/features/collection/use-log-state';
import { heroRankFor } from '@/features/collection/hero-rank';
import {
  useRankedCollection,
  type RankingCategory,
} from '@/features/collection/use-collection';
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
import { FollowingRatingsSheet } from '@/features/title/FollowingRatingsSheet';
import { GenreRow } from '@/features/title/GenreRow';
import { PersonalScore } from '@/features/title/PersonalScore';
import { Synopsis } from '@/features/title/Synopsis';
import { TitleActions, type TitleAction } from '@/features/title/TitleActions';
import { NAV_BAR_HEIGHT, TitleTopBar } from '@/features/title/TitleTopBar';
import { WhereToWatch } from '@/features/title/WhereToWatch';
import { useCredits } from '@/features/title/use-credits';
import { seasonListIsStale, useTitleEnrichment } from '@/features/title/use-enrichment';
import { TitleReviews } from '@/features/title/TitleReviews';
import { useTitleVideos } from '@/features/title/use-title-extras';
import { useTitleReviews, type ReviewSort } from '@/features/title/use-title-reviews';
import { useSeasonEpisodes } from '@/features/title/use-season-episodes';
import { diagnose } from '@/lib/diagnose';
import { heroArtwork } from '@/lib/hero';
import { languageName } from '@/lib/language';
import { track } from '@/lib/analytics';
import { posterUri, profileUri, stillUri, videoUri } from '@/lib/images';
import { resolveMetadata } from '@/lib/media-metadata';
import { queryKeys } from '@/lib/query';
import { supabase } from '@/lib/supabase';
import { relativeTime } from '@/features/recommendations/use-sent-to-you';
import { compactName } from '@/lib/titles';
import {
  CastStrip,
  EmptyState,
  EpisodeRow,
  LoadingScreen,
  Poster,
  Screen,
  ScreenError,
  ScoresSection,
  SegmentedTabs,
  Sheet,
  SheetRow,
  SkeletonRow,
  Text,
  TitleHero,
  TitleRow,
} from '@/ui/components';
import { theme } from '@/ui/tokens';

/**
 * What this route shows when its own render throws.
 *
 * Expo Router wraps the route component in this and **nothing above it**, which is the
 * whole reason it exists: the root `RouteErrorBoundary` wraps `<Stack>`, so catching
 * there takes the navigator down and the reader loses the page they were on and
 * everything behind it — which is what put the founder back on Feed after a title-page
 * crash rather than on the title page. Caught here, the route stays on the stack, Back
 * still returns to whatever pushed it, and `retry` re-renders in place.
 *
 * See `lib/render-errors.ts` for what is reported, and `ScreenError` for why the
 * exception is named on a beta build and not on a store one.
 */
export function ErrorBoundary({ error, retry }: ErrorBoundaryProps) {
  return <ScreenError error={error} retry={retry} />;
}

type Tab = 'episodes' | 'cast' | 'reviews' | 'videos' | 'details' | 'seasons';

/**
 * How many episodes a season page draws before it offers to show the rest.
 *
 * Ordinary seasons run six to twenty-four and never reach this. It exists for the
 * ones the provider models as a single long run — a daily soap, or a long anime
 * season — where two hundred rows with a still apiece is a lot of images inside a
 * `ScrollView` that has to lay all of them out at once.
 *
 * A bounded first page rather than a `FlatList`: nesting a vertical virtualized list
 * inside this vertical `ScrollView` is the arrangement React Native warns about, and
 * it breaks the scrolling of the page it is nested in. Nothing is lost — "Show all"
 * reveals the rest, and no metadata is dropped on the way.
 */
const EPISODES_FIRST_PAGE = 50;

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
  /** Drains the post-ranking celebration queue when the log flow ends. */
  const celebrate = useCelebrationHandoff();
  const router = useRouter();
  // For the hero and the bar over it: the navigation overlays the artwork, so both need
  // to know how much of the top belongs to the status bar (TitleHero's `topInset`).
  const insets = useSafeAreaInsets();
  // The hero is the backdrop's own 16:9, so the width decides where it ends — which is
  // where the navigation has finished becoming a header.
  const { width: screenWidth } = useWindowDimensions();
  const hasId = Boolean(id);
  const [watchlistBusy, setWatchlistBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  // Reset by leaving the screen and nothing else. A reader who asked to see all of a
  // long season should not have it collapse again when they visit Cast and come back.
  const [showAllEpisodes, setShowAllEpisodes] = useState(false);
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
  /**
   * Which stacked row the log sheet should arrive with open, if any.
   *
   * Set by *Who I watched with* and by nothing else. Its sibling `openWriting` names a
   * piece of writing; this names a field, and both exist so a menu row that promises one
   * thing lands the reader on that thing rather than on a sheet where they have to find
   * the row again.
   */
  const [openSection, setOpenSection] = useState<'who' | null>(null);
  const [rankingSubject, setRankingSubject] = useState<RankingSubject | null>(null);
  // Top by default, which is the founder's choice: a first-time reader wants the
  // review other people found worth reacting to, not the one written most recently.
  const [reviewSort, setReviewSort] = useState<ReviewSort>('top');
  const [recommending, setRecommending] = useState(false);
  /** The Ranked control's menu: change the rating, drop it, or remove the title. */
  const [managing, setManaging] = useState(false);
  /** The people behind the Following score (§13), opened from the Scores section. */
  const [followingRatingsOpen, setFollowingRatingsOpen] = useState(false);
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
          //
          // `episode_count` and the parent's `certification` are the two columns the
          // identity line needs and did not have (2026-09-07). A season's length is its
          // episode count rather than a runtime (`20260820000400`), and TMDB publishes a
          // rating on the *series* and never on a season — so `effectiveCertification`
          // could not inherit one, and every season page read as having no rating at
          // all. Two more columns on a read that was already being made: no new request,
          // no new dependency.
          'id, kind, title, season_number, release_date, runtime_minutes, episode_count, overview, poster_path, backdrop_path, genres, provenance, tmdb_id, original_language, certification, fetched_at, parent:parent_id(id, title, poster_path, backdrop_path, genres, original_language, certification)',
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
  // Seeded rows arrive with no artwork, overview or credits. Opening the screen is
  // what fetches them, unless the bulk pass got there first.
  // The second condition is about the Phase E deployment rather than about this title:
  // a null videos facet means nobody has asked TMDB about its trailers since the
  // adapter learned to store them, which is true of every row enriched before
  // 2026-08-17 and of nothing else. `useTitleVideos` explains why null and empty are
  // different answers.
  /**
   * The third reason to ask, added 2026-08-30: **this series' season list has gone
   * stale.**
   *
   * `isThin` asks about artwork, an overview and a runtime, all of which a series
   * acquires once and keeps — so a series page never re-enriched, and its season list
   * stayed whatever was true the day somebody first opened it. This is the screen the
   * founder was looking at when a show turned out to be short of a season, so it is the
   * screen that has to be able to ask again.
   *
   * It rides on `alsoWhen` rather than on a second hook, and that is not a tidiness
   * preference: `useEnrichOnce` de-duplicates by id **within one hook instance**, so two
   * hooks looking at the same series would each spend a provider request on it. One
   * reason, one call, one request. `useSeasonEnrichment` still exists for `SeasonPicker`,
   * which reaches a series this screen never mounted.
   */
  const seasonListNeedsReading =
    data?.title?.kind === 'series' &&
    seasons.isFetched &&
    ((seasons.data ?? []).length === 0 ||
      // The **series'** timestamp, not the seasons': the adapter writes the series row
      // and the whole season list in one request, so this is when the list was last
      // asked for. Reading it off the seasons let a one-season show vouch for a list it
      // had never re-read — see `seasonListIsStale`.
      seasonListIsStale(seasons.data ?? [], data?.title?.fetched_at ?? null));
  const { enriching } = useTitleEnrichment(
    data?.title ?? null,
    videos.data === null || seasonListNeedsReading,
  );
  /**
   * The Episodes tab's data, on a season and nowhere else.
   *
   * **Lazy, and normally already answered.** `enabled` stays false until Episodes is
   * the tab being shown, so a reader who opens a season page and goes straight to
   * Reviews spends nothing here. When it does turn on, the data is usually in hand:
   * a season's enrichment reads `/tv/{series}/season/{n}`, that response carries the
   * episodes, and `use-enrichment` writes them into this exact cache key.
   *
   * The `tab === null` half is what makes that work on arrival. Episodes leads a
   * season's tab row and `activeTab` falls back to the first entry, so a reader who
   * has chosen nothing is looking at Episodes; waiting for `tab` to be set would make
   * the default tab the one tab that never loaded.
   *
   * **`!enriching` is the half that keeps it free**, and it has to be read after the
   * enrichment hook rather than before it. Enabling the query while an enrichment is
   * in flight would race the seed and spend a second provider request to fetch what
   * the first one is already bringing back. Once the enrichment settles, either it
   * seeded this key — in which case the query finds fresh data and asks nobody — or
   * it did not, and this is the fallback doing its job.
   */
  const showsEpisodes = data?.title?.kind === 'season' && (tab === null || tab === 'episodes');
  const episodes = useSeasonEpisodes(titleId, showsEpisodes && !enriching);
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

  /**
   * How far the page has scrolled, as one animated value.
   *
   * Above the early returns for the reason the comment below already gives, and held in
   * state rather than in a ref because a ref read during render is what `react-hooks/refs`
   * forbids — `DetailHeaderTitle` uses the same lazy initialiser for the same reason.
   *
   * Everything the navigation does on the way past the hero is an interpolation of this:
   * the Paper ground arriving, the compact title fading up, and the crossfade between the
   * light glyphs on artwork and the Ink ones on Paper. One value, so none of the three can
   * be at a different point in the transition from the others — which is what a boolean
   * threshold could not promise, because a boolean has no middle.
   */
  const [scrollY] = useState(() => new Animated.Value(0));
  /**
   * The same crossing, as a boolean, for assistive technology alone.
   *
   * The bar's compact title is always mounted so it can fade, which means a screen reader
   * would meet the title twice on every title page — once in the bar and once in the
   * identity block below it. That is exactly the duplication the detail-header rule exists
   * to prevent, and an animated opacity cannot express it, because the accessibility tree
   * has no half-way. So the eye gets the interpolation and the tree gets this, crossed
   * with hysteresis in the scroll listener below.
   */
  const [barRevealed, setBarRevealed] = useState(false);

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
        <EmptyState
          kind="nothingMatches"
          title="Title not found"
          body="This link is incomplete."
        />
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
    // Selected since 2026-09-07, and passed here since the identity line started reading
    // its rating from the resolver rather than from the column. Without it
    // `effectiveCertification` sees an absent field on every kind of title and answers
    // null, which silently dropped `PG-13` from every film as well as failing to inherit
    // `TV-MA` for a season — the resolver is structural, so an unpassed field and a null
    // one are the same answer to it.
    certification: title.certification,
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
  /**
   * Where the navigation finishes turning into a header.
   *
   * `TitleHero` sizes its frame from the artwork's own 16:9, or falls back to the
   * collapsed band when there is none, so the same arithmetic gives the right answer for
   * a film with a backdrop, a season borrowing its series' key art, and a seeded row with
   * no image at all. Minus the bar's own height, because the bar is *over* the hero: the
   * transition should be finished when the artwork has reached the bottom of the bar, not
   * when it has reached the top of the screen.
   *
   * Two points is the floor rather than zero, so the interpolation's input range is
   * always strictly increasing — a hero shorter than the bar is a real case (the
   * collapsed band on a small display) and an equal pair would be a runtime error rather
   * than a wrong fade.
   */
  const barHeight = insets.top + NAV_BAR_HEIGHT;
  /**
   * The hero's height when there is no artwork: the bar, plus a band under it.
   *
   * Measured rather than constant, because the navigation now overlays the hero instead
   * of sitting above it — a fixed band shorter than the bar would put the poster's top
   * under the back control on a device with a tall status bar.
   */
  const collapsedHero = barHeight + HERO_COLLAPSED_BAND;
  const revealEnd = Math.max(
    (hero.uri ? screenWidth / theme.layout.aspect.backdrop : collapsedHero) - barHeight,
    2,
  );
  const revealStart = Math.max(revealEnd - REVEAL_WINDOW, 0);
  /**
   * The short name of this exact entity — `Season 1` for a season, the film's own title
   * for a film.
   *
   * Still what the compact bar says once the page has stopped naming itself, and still
   * what every sheet and alert on this page calls the thing. What changed on 2026-09-07
   * is where it sits *in the identity block*: see `primaryName` below.
   */
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

  const rankCategoryLabel = data.ranked?.category === 'tv_seasons' ? 'TV' : 'Movies';
  // One line only, chosen by the founder's rule: top ten overall, else the
  // strongest category placement. Derived from rows already cached.
  const heroRank = data.ranked
    ? heroRankFor(title.id, rankedList.data ?? [], rankCategory)
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

  /**
   * **What the page calls the thing, and what it calls the part of it you are on**
   * (founder redesign, 2026-09-07).
   *
   * The identity block is now poster-left, words-right, so the words have a column
   * rather than a full-width band — and in a column the hierarchy has to be the one a
   * reader scans. For a season that is *the show* first and the season second: somebody
   * arriving at this page is arriving at The Last of Us, and which season they are on is
   * the qualifier.
   *
   * It ran the other way until now — a small Maroon series line above `Season 1, 2023`
   * in `title1` — which put the least identifying string on the page in the largest type
   * it has. The series name is still the way to the series page; it is now the heading
   * that leads there rather than a link above the heading.
   *
   * A film has no such split, so it is its own name over its own year.
   */
  const primaryName = (isSeason ? (parent?.title ?? title.title) : title.title) || title.title;
  /**
   * `Season 1, 2023`, or `2010`.
   *
   * A comma joins a season to its year in every place anybody writes one down, and the
   * em-dash form the log sheet uses — "Parks and Recreation — Season 2" — is for surfaces
   * with one line to say the whole name in. Here there is a hierarchy to put it in.
   */
  const identitySubtitle = isSeason
    ? [displayTitle ?? title.title, year].filter(Boolean).join(', ')
    : year
      ? String(year)
      : null;

  /**
   * `TV-MA · 9 episodes · Craig Mazin`, or `PG-13 · 145 min · Destin Daniel Cretton`.
   *
   * Certification first: it is the fact somebody scans for before deciding whether to put
   * a film on. `descriptive.certification` rather than the column, so a season inherits
   * its series' rating — TMDB publishes one on the series and never on a season, and the
   * line read as ratingless on every season page until the parent embed started carrying
   * it (`lib/media-metadata.ts`).
   *
   * Then the length, which is a *different measure* per kind: a film's runtime, a
   * season's episode count. That is the rule `20260820000400` established for the feed,
   * applied here for the first time — the line used to print a runtime for a season,
   * which is a column TMDB does not fill, so the segment was simply missing.
   *
   * Then the credit. A film's director; for television, the best equivalent the credits
   * already fetched can offer — a creator or an executive producer, in that order — and
   * nothing at all when the payload has none. **No new request is made to fill this
   * line**: it reads the `credits` facet this screen was already asking for.
   *
   * Built by filtering, so a missing part never leaves a stray separator, and the whole
   * line is absent rather than empty when all three are: an empty `Text` is a line box
   * with the footnote's height, which reads as a gap under the title.
   */
  const lengthLabel = lengthOf(title.kind, title.runtime_minutes, title.episode_count);
  const metaLine = [
    descriptive.certification,
    lengthLabel,
    credits.data?.director ?? credits.data?.showrunner ?? null,
  ]
    .filter(Boolean)
    .join(' · ');

  /**
   * The reader's own context under the metadata: where it sits, and when they saw it.
   *
   * The ordinal was a line of its own beside a detached score and is now a segment of
   * this one, which is the founder's "incorporate it without cluttering the identity
   * block": `#1 in TV` is four characters of information and does not deserve a row.
   * `heroRankFor` still decides whether there is one at all — top ten only, or nothing.
   *
   * The watch date has never been on this page. It is the other half of "what have I
   * done with this", it is already fetched, and a reader who cannot remember whether they
   * have seen something is exactly who this page is for.
   */
  const watchedLine = data.logged?.watched_on
    ? `Watched ${formatShortDate(data.logged.watched_on)}`
    : null;
  const contextLine = [heroRank?.label ?? null, watchedLine].filter(Boolean).join(' · ');

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
    /**
     * Episodes first, and first only for a season.
     *
     * The founder's decision, and it is the same argument Seasons wins on one level
     * up: a season page's job is to help somebody decide whether they watched this
     * season, and episode titles, dates and stills are what settle that. Cast does
     * not — a series' cast barely changes between seasons, so it is the least
     * distinguishing thing on the page it leads.
     *
     * First also means default, because `activeTab` falls back to the head of this
     * row. That is intended: opening a season onto its episodes is the whole feature.
     *
     * Rendered even when the list is empty, on the same rule Seasons follows. A
     * season always has episodes; an empty list means they have not arrived yet, and
     * saying which of those it is beats removing the tab under a reader who is
     * waiting for it. Never present for a film or a series grouping.
     */
    ...(isSeason ? [{ id: 'episodes' as const, label: 'Episodes' }] : []),
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
    // The same idea for a row that is not writing: Who I watched with opens the
    // companion picker. Mutually exclusive with `writing` in practice — one sheet has
    // one row open — and `LogSheet` resolves the pair if a caller ever passes both.
    section: 'who' | null = null,
  ) => {
    if (!rankable) return;
    setActionError(null);
    setLogIntent(intent);
    setOpenWriting(writing);
    setOpenSection(section);
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

  /**
   * **Adjust placement: the same watch, comparisons redone.**
   *
   * One implementation, reached from two places — the first action in the group under
   * the identity, and the *Adjust placement* row in the menu behind `⋯`. That is not
   * tidiness: the whole point of the 2026-09-07 label pass was that the three ranking
   * intents must be unmistakable, and two call sites each assembling their own
   * `RankingSubject` is how a `mode` drifts.
   *
   * `mode: 'rerank'` is `rankAgain` with `newWatch: false`: the session runs over the
   * position the title already holds, and finishing replaces it **without announcing
   * anything**. `_rank_finalize` posts `title_ranked` only `if p_new_watch or not
   * v_replaced` (20260826000500), so no feed activity is written. The rewatch row —
   * *I watched it again* — is the one place in the app that declares a second viewing,
   * and it is the only one that passes `mode: 'again'`.
   *
   * Nothing about the ranking maths, the score or the schema is touched by this pass.
   */
  const adjustPlacement = () => {
    if (!rankedBucket) return;
    setManaging(false);
    setActionError(null);
    setRankedTitle(loggable);
    setRankingSubject({
      id: title.id,
      title: title.title,
      bucket: rankedBucket,
      posterUri: posterUri(title.poster_path, 'card'),
      // Only a film or a season is ever ranked; a series has no menu.
      kind: title.kind === 'season' ? 'season' : 'movie',
      mode: 'rerank',
    });
  };

  /**
   * The three things you can do to this title, as one group (`TitleActions`).
   *
   * **The first one is the rank intent, and which intent depends on whether there is a
   * ranking to adjust.** A ranked title's first action redoes the comparisons for the
   * watch it already has; an unranked one's opens the log, which is where a rating is
   * chosen and a first ranking begins. They are the same position because they are the
   * same act at two stages, which is what the old arrangement — a Maroon `Rank` button
   * that turned into an outlined `✓ Ranked` chip in a different place — could not say.
   *
   * A series gets Save alone: it cannot be ranked or recommended (PRD §10), which is
   * the same rule the labelled row this replaces applied.
   */
  const actions: TitleAction[] = [
    ...(rankable
      ? [
          data.ranked
            ? ({
                id: 'adjust',
                icon: 'swap-vertical-outline',
                label: 'Adjust',
                accessibilityLabel: `Adjust where ${displayTitle ?? title.title} sits in your ranking`,
                onPress: adjustPlacement,
                // The band arrives with the personal read. Pressing before it lands would
                // open a session with no bucket to run it in.
                disabled: !rankedBucket,
              } as const)
            : ({
                id: 'rank',
                icon: 'star-outline',
                label: 'Rank',
                accessibilityLabel: `Rank ${displayTitle ?? title.title}`,
                onPress: () => openLog(),
              } as const),
        ]
      : []),
    {
      id: 'save',
      icon: isWatchlisted ? 'bookmark' : 'bookmark-outline',
      label: isWatchlisted ? 'Saved' : 'Save',
      // The sentences the labelled control used, unchanged: a screen reader's name for
      // this control is what says which way the toggle goes.
      accessibilityLabel: isWatchlisted
        ? `Remove ${title.title} from your watchlist`
        : `Add ${title.title} to your watchlist`,
      onPress: () => void toggleWatchlist(),
      selected: isWatchlisted,
      disabled: watchlistBusy,
    },
    ...(rankable
      ? [
          {
            id: 'recommend',
            icon: 'paper-plane-outline',
            label: 'Recommend',
            accessibilityLabel: `Recommend ${title.title} to a friend`,
            onPress: () => {
              setActionError(null);
              setRecommendedTo(null);
              setRecommending(true);
            },
          } as const,
        ]
      : []),
  ];

  return (
    <Screen includeBottomInset edges={[]}>
      {/**
       * **No navigator header on this route** (founder redesign, 2026-09-07).
       *
       * It was `headerTransparent` with a `headerBackground` that was mounted or not
       * according to a boolean, which gives two states and nothing between them: the
       * ground and the title arrived at a threshold, in one frame. The brief asks for a
       * surface that *gains* opacity as the hero leaves, and for the icon treatment to
       * change with it — and `headerTintColor` is a navigation option rather than a value
       * that can be animated.
       *
       * So the bar is drawn by the page, over the artwork, from one `Animated.Value`
       * (`TitleTopBar`). The route keeps its `title` because on iOS a route's title is the
       * back label of whatever is pushed *on top* of it — a person page opened from the
       * cast strip says `‹ Title` and not `‹ title/[id]`.
       */}
      <Stack.Screen options={{ title: title.title, headerShown: false }} />

      <TitleTopBar
        progress={scrollY.interpolate({
          // Zero while the hero is whole; one by the time it has left. The window is the
          // last 96 points of the hero's own height, so a tall backdrop and the short
          // collapsed band both finish the transition at the moment the artwork does —
          // which is what "by the time the hero is leaving the viewport" means on a
          // device this code cannot measure in advance.
          inputRange: [revealStart, revealEnd],
          outputRange: [0, 1],
          extrapolate: 'clamp',
        })}
        revealed={barRevealed}
        // `router.back()` and nothing else. The native control this replaces did exactly
        // this, so a title opened from Search returns to Search and one opened from the
        // feed returns to the feed — the route stack decides, not this screen.
        onBack={() => router.back()}
        // The menu, where the Ranked control used to keep it. Present only where there is
        // something to manage, which is a ranked title — the same reachability the chip
        // had, moved rather than widened.
        onMore={data.ranked ? () => setManaging(true) : undefined}
        title={displayTitle ?? title.title}
        subtitle={parent?.title ?? null}
      />

      <Animated.ScrollView
        contentContainerStyle={styles.content}
        onScroll={Animated.event([{ nativeEvent: { contentOffset: { y: scrollY } } }], {
          // Opacity is one of the properties the native driver can carry, so the bar's
          // transition runs on the UI thread and keeps up with a page that is also laying
          // out a season's worth of episode stills.
          useNativeDriver: true,
          /**
           * The accessibility half, and the only thing on this path that touches React
           * state. Hysteresis on the two ends of the fade rather than a single threshold,
           * so a finger resting on the crossing point cannot make the compact title enter
           * and leave the tree on every pixel of movement — the same dead band
           * `useDetailHeader` uses, expressed as the window the fade already has.
           * `setState` with an unchanged value is a no-op, so an ordinary scroll re-renders
           * this screen exactly twice: once on the way in and once on the way out.
           */
          listener: (event: NativeSyntheticEvent<NativeScrollEvent>) => {
            const y = event.nativeEvent.contentOffset.y;
            setBarRevealed((was) => (was ? y > revealStart : y >= revealEnd));
          },
        })}
        scrollEventThrottle={16}
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
            // Below the transparent bar, so the spinner is not drawn under the back
            // control on a screen whose content starts at the top of the display.
            progressViewOffset={insets.top + NAV_BAR_HEIGHT}
            tintColor={theme.semantic.action}
            colors={[theme.semantic.action]}
          />
        }
      >
        <View>
          <TitleHero
            uri={hero.uri}
            blurred={hero.treatment === 'poster'}
            collapsedHeight={collapsedHero}
            topInset={insets.top}
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

              Only where there *is* artwork. The collapsed band is exactly POSTER_LIFT
              tall and the poster rises the whole way into it, so a title with no
              backdrop has no hero to overlay — an absolute callout there would sit on
              the poster or above the screen. That case gets the same callout inline,
              under the heading. */}
          {recommendedBy && hero.uri ? (
            <RecommendedCallout label={recommendedBy} overlay />
          ) : null}
        </View>

        {/**
         * **Poster left, identity right** (founder redesign, 2026-09-07).
         *
         * The poster used to sit alone under the hero with a detached score column
         * opposite it, and the title, year and metadata began on a full-width band
         * below both. Three bands, for one fact: what this is and what I made of it.
         *
         * They are one row now. The poster rises into the artwork as before — the page
         * keeps its one straddling object — and everything that names the title sets
         * beside it, in a column, in the order a reader scans: what it is called, which
         * part of it this is, what it is, and then where it sits for them.
         *
         * The score comes with the poster rather than the words, anchored to its lower
         * corner, because it is a fact about *this* title and the poster is the only
         * thing on the page that can only be about this title. See `PersonalScore`.
         */}
        <View style={styles.identity}>
          <View style={styles.posterColumn}>
            <View style={styles.posterFrame}>
              <Poster
                uri={posterUri(title.poster_path, 'card')}
                title={title.title}
                // `md`, down from `lg`. The poster is no longer the page's only object
                // at this height — it now shares the row with the whole identity — and a
                // 132pt frame left a column too narrow to set a serif title in.
                size="md"
              />
            </View>
            {/* Over the poster's lower outside corner, half on and half off. A series
                has no score because it cannot be ranked (PRD §10), so it gets no anchor
                rather than an empty one. */}
            {rankable ? (
              <View style={styles.scoreAnchor} pointerEvents="box-none">
                <PersonalScore
                  score={score}
                  // Ranked, but the band sizes that derive the number have not landed.
                  // A dashed "Rank" ring here would contradict the Adjust control beside
                  // it; an empty circle says "there is a score, it is not here yet".
                  pending={Boolean(data.ranked) && score == null}
                  bucket={data.ranked?.bucket ?? null}
                  // Where the Ranked chip led, unchanged: a ranked title opens its
                  // options, an unranked one opens the log.
                  onPress={() => (data.ranked ? setManaging(true) : openLog())}
                />
              </View>
            ) : null}
          </View>

          <View style={styles.identityCopy}>
            {/* For a season the heading is the show, and the show is also the way to
                the series page — so the heading is the link rather than a small line
                above it. A film's name leads nowhere and is not a control. */}
            {isSeason && parent?.id ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`${primaryName}, the series this belongs to`}
                onPress={() => router.push(`/title/${parent.id}`)}
                hitSlop={theme.space[1]}
              >
                <Text testID="title-name" variant="title1">
                  {primaryName}
                </Text>
              </Pressable>
            ) : (
              <Text testID="title-name" variant="title1">
                {primaryName}
              </Text>
            )}
            {identitySubtitle ? (
              <Text testID="title-subtitle" variant="callout" tone="secondary">
                {identitySubtitle}
              </Text>
            ) : null}
            {/* Built before it is rendered, because all three parts can be missing at
                once — an obscure title with no certification, no length and no credit —
                and an empty `Text` is not nothing on screen. It is a line box with the
                footnote's height, which reads as a gap under the title. Review 17e. */}
            {metaLine ? (
              <Text testID="title-meta" variant="footnote" tone="secondary">
                {metaLine}
              </Text>
            ) : null}
            {contextLine ? (
              <Text testID="title-context" variant="caption" tone="tertiary">
                {contextLine}
              </Text>
            ) : null}
          </View>
        </View>

        {/* Adjust or Rank, Save, Recommend — one group, one baseline, one weight.
            See `TitleActions` for why the giant Ranked button is not among them. */}
        <TitleActions actions={actions} />

        {/* The no-artwork case for the recommendation callout. Same object, laid out in
            the flow rather than over a hero that is not there. */}
        {recommendedBy && !hero.uri ? (
          <View style={styles.block}>
            <RecommendedCallout label={recommendedBy} />
          </View>
        ) : null}

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
              {diagnose(personal.error) ??
                'Your rating and watchlist state could not be loaded.'}
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

        {/**
         * **The description, then the genres** (founder redesign, 2026-09-07).
         *
         * They have been the other way round twice, and the argument for genres-first was
         * that the page reads outward — what the thing is called, what it is, what it is
         * about. It is a good argument and it lost to what the page actually looked like:
         * a row of chips between the title and the prose put a band of metadata in the
         * one place a reader is trying to start reading.
         *
         * The order now is prose then chips, and the two sit close together because the
         * `more` marker is guaranteed to be *on* the fourth line rather than under it
         * (`Synopsis`). That is the whole reason this pair could be tightened: the old
         * clamp routinely spent a fifth line on one word, and genres set below an
         * almost-empty line read as a third block rather than as the footnote to the
         * paragraph they are.
         */}
        {title.overview ? <Synopsis text={title.overview} /> : null}

        {/**
         * **One measured row**, and the count is always on it.
         *
         * A fixed three chips plus `+N` wrapped the marker onto a second line whenever
         * the third chip fitted and the marker did not — Dan Da Dan, exactly. `GenreRow`
         * keeps as many as fit and puts the count on the same line, always. Tapping any
         * chip or the count opens the full list; Details still lists them all too.
         *
         * Genres stay neutral metadata. They are chips rather than Maroon pills because
         * a genre is a fact about the title and not something to do to it.
         */}
        <GenreRow genres={descriptive.genres} />

        {/**
         * **`SCORES`, with its heading back and Following leading** (founder redesign,
         * 2026-09-07).
         *
         * The block has now sat in three places and the reasoning is worth stating once.
         * It began under the tabs — wrong, because the scores vanished when somebody
         * looked at the cast. It moved directly under the title's metadata on 2026-09-06,
         * on the argument that what everybody made of a film is part of what the film
         * *is*; that is still true and it lost to a bigger problem, which is that the
         * page had been cut into six small bands. It is in the lower half now, after the
         * description, where it is the first thing that stops being about the title and
         * starts being about what other people made of it — which is exactly why it has a
         * heading again. See `ScoresSection`.
         *
         * Still above the tabs and never inside them, which is the standing rule: scores
         * are core bingd. data and must not appear and disappear as somebody looks at the
         * cast.
         *
         * A series has no aggregate of its own, because it cannot be ranked (PRD §10), so
         * it gets no row rather than a permanent "Not enough ratings".
         *
         * **The reader's own score is not in here.** It is on the poster, with `YOU` on
         * it. It led this row as well until 2026-08-18, which put the same number on the
         * page twice and made the second copy the weaker one. Founder correction, kept.
         */}
        {!isSeries ? (
          <ScoresSection
            bingd={{
              score: community.data?.score ?? null,
              ratingCount: community.data?.ratingCount ?? 0,
            }}
            following={{
              score: following.data?.score ?? null,
              ratingCount: following.data?.ratingCount ?? 0,
            }}
            // §13: the aggregate opens its members. Only offered once the count is
            // real — ScoresSection itself refuses a tap on an empty unit.
            onPressFollowing={() => setFollowingRatingsOpen(true)}
          />
        ) : null}

        {/* Under the scores, over the tabs, and on every kind of title — including
            a series, which has no score block of its own because it cannot be ranked.

            The founder's placement decision, and the reason it is not a tab: a film
            opens on Cast and a season opens on Episodes, both of which are those
            pages' whole point, and a fifth entry on a season's row would push one of
            them off the edge. Availability is worth finding without a tab hunt and is
            not worth a hero band, so it is a row that grows into a sheet.

            It draws nothing at all when the provider has no answer, has not answered
            yet, or failed — see `WhereToWatch`. That is what keeps a non-critical
            block from making the page it sits on less reliable. */}
        <WhereToWatch mediaItemId={title.id} titleName={title.title} />

        <View style={styles.tabs}>
          <SegmentedTabs
            options={tabs}
            value={activeTab ?? 'details'}
            onChange={(next) => setTab(next)}
          />
        </View>

        {/* Episodes. Informational only: no row here is pressable, scoreable or
            loggable, because the rankable unit is the season this page already is
            (PRD §10). What the list does is answer "did I watch this one". */}
        {activeTab === 'episodes' ? (
          episodes.data?.length ? (
            <View>
              {(showAllEpisodes
                ? episodes.data
                : episodes.data.slice(0, EPISODES_FIRST_PAGE)
              ).map((episode, index) => (
                <View
                  // Keyed on position as well as number. TMDB occasionally repeats an
                  // episode number within a season, and the normalizer keeps both
                  // rather than losing a real episode to tidy up a display key.
                  key={`${episode.episode_number}-${index}`}
                >
                  {/* No rule between episodes (founder, 2026-09-07). A hairline every
                      row turned a season page into a table, which is the density note
                      that runs through this whole pass: whitespace is the separator, and
                      a rule marks a module rather than a sibling. `EpisodeRow`'s own
                      vertical padding already puts 32 points between two of them, and
                      the still and the number make the boundary obvious besides. */}
                  <EpisodeRow
                    episodeNumber={episode.episode_number}
                    title={episode.title}
                    airDate={formatAirDate(episode.air_date)}
                    runtimeMinutes={episode.runtime_minutes}
                    stillUri={stillUri(episode.still_path)}
                    overview={episode.overview}
                  />
                </View>
              ))}

              {!showAllEpisodes && episodes.data.length > EPISODES_FIRST_PAGE ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Show all ${episodes.data.length} episodes`}
                  onPress={() => setShowAllEpisodes(true)}
                  style={({ pressed }) => [styles.showAll, pressed && styles.pressed]}
                >
                  <Text variant="callout" tone="action">
                    Show all {episodes.data.length} episodes
                  </Text>
                </Pressable>
              ) : null}
            </View>
          ) : episodes.isPending || enriching ? (
            <SkeletonRow count={3} />
          ) : episodes.isError ? (
            <EmptyState
              kind="nothingYet"
              compact
              title="Episodes did not load"
              body="Pull down to try again."
            />
          ) : (
            // Distinct from the error above, and the difference is worth the words: a
            // season the provider has published no episode list for is a fact about
            // the show, not a fault the reader can retry away.
            <EmptyState
              kind="nothingYet"
              compact
              title="No episodes listed"
              body="TMDB has not published an episode list for this season yet."
            />
          )
        ) : null}

        {activeTab === 'cast' ? (
          <CastStrip
            cast={cast}
            onPressMember={(member) => router.push(`/person/${member.id}`)}
          />
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
                    {[SITE_LABEL[video.site] ?? video.site, video.type]
                      .filter(Boolean)
                      .join(' · ')}
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
            viewerHasReview={(reviews.data ?? []).some(
              (review) => review.userId === profile.id,
            )}
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
                data.ranked && total
                  ? `#${data.ranked.position} of ${total} in ${rankCategoryLabel}`
                  : null
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
      </Animated.ScrollView>

      <LogSheet
        title={loggingTitle}
        surface="title"
        noteIntent={logIntent}
        openWriting={openWriting}
        openSection={openSection}
        postRank={placement}
        /* Both exits end the post-ranking flow, so both drain the celebration queue.
           This is the half the founder physically hit: a reader who takes *Add details*
           finishes here rather than on the reveal, and the payoff used to be held by a
           ranking sheet that had already unmounted. Empty queue, nothing happens. */
        onDone={() => {
          setLoggingTitle(null);
          setPlacement(null);
          celebrate();
        }}
        onClose={() => {
          setLoggingTitle(null);
          setPlacement(null);
          setActionError(null);
          celebrate();
        }}
        onRank={(bucket, mode) => {
          if (!loggingTitle) return;
          setRankingSubject({
            id: loggingTitle.id,
            title: loggingTitle.title,
            bucket,
            posterUri: loggingTitle.posterUri,
            kind: loggingTitle.kind,
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
        // Ranking is a subflow of logging, so it returns to the log rather than ending
        // at a number. The same sheet, on the same title, with the score at the top of
        // it — there is one implementation of "the rest of your log" and this is it.
        onFinishLog={(result) => {
          setRankingSubject(null);
          if (!rankedTitle) return;
          setLogIntent('note');
          /**
           * **Cleared, and it is the founder's "Add more details opens only the Note".**
           *
           * `openWriting` is set by the Ranked menu's writing row and is not reset by
           * anything else on this screen, so a reader who came in that way, changed the
           * rating from inside the sheet and finished the comparison arrived back at a
           * log sheet already expanded into the note composer — with the companions and
           * the watch date pushed under a keyboard.
           *
           * `LogSheet` also refuses to auto-expand in the post-rank state, which is the
           * load-bearing half because there are two callers. This is the other half:
           * the intent belonged to a visit that has ended, and carrying it forward would
           * be wrong even if nothing read it.
           */
          setOpenWriting(null);
          setOpenSection(null);
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
             * **One field, one row (founder simplification, 2026-08-27).**
             *
             * `user_media` holds one `note` under one `note_visibility`, and the sheet
             * now shows it as one thing: a note, with "Share as a review" as a state it
             * can be in. The two rows this replaces — Review and Private note, each
             * offering the conversion the other way — asked the reader to choose
             * between two names for one piece of writing before opening it, which was
             * the founder's exact complaint about the sheet itself. The label still
             * says which state the writing is in, because "Edit your review" is a
             * promise about where the text is visible; the conversion controls live in
             * the composer, beside the text they describe.
             *
             * **The founder's device pass: every `value` in this menu is gone.**
             * `SheetRow` draws the label and the secondary sentence on one line, so at
             * the width of a phone every explanation truncated — rows of clipped grey
             * text under clear labels, worse than no explanation at all.
             */}
            <SheetRow
              icon="chatbubble-ellipses-outline"
              label={
                hasReview
                  ? 'Edit your review'
                  : hasPrivateNote
                    ? 'Edit your note'
                    : 'Add a note'
              }
              onPress={() => {
                setManaging(false);
                openLog('note', hasReview ? 'public' : 'private');
              }}
            />

            {/**
             * **Directly under the writing row, because it is the other half of the
             * same log** (founder, 2026-08-29).
             *
             * Companions were reachable only through *Change your rating*, which opens
             * the bucket chooser — so the way to correct who you watched something with
             * ran through a control that offers to re-rate it. The founder's device pass
             * called that hidden, and it is: the row a reader is looking for is named
             * "Who I watched with" and the row they had to press was named something
             * else entirely.
             *
             * **It edits the log occurrence that is already there.** `openLog` opens
             * the same sheet every other entry point opens, on the same `user_media`
             * row, with the companion picker expanded — `section`, not `writing`, so
             * the note composer stays closed and the keyboard stays down. It starts no
             * ranking, writes no bucket, creates no second log and posts no activity;
             * `useSetCompanions` remains the only writer, so watched-with notification
             * is exactly as once-only as it was from every other door.
             *
             * In *Your log* rather than in *Ranking* for the same reason the note is:
             * this group is what you recorded about watching it, and the group below is
             * where it sits against everything else.
             */}
            <SheetRow
              icon="people-outline"
              label="Who I watched with"
              onPress={() => {
                setManaging(false);
                openLog('note', null, 'who');
              }}
            />

            <MenuGroup title="Ranking" />
            {/**
             * **Three intents, and the founder pressed the wrong one because the labels
             * did not distinguish them** (physical Android, 2026-09-07).
             *
             * The report: ranked *Terrace House: Tokyo 2019-2020, S1*, adjusted the
             * placement a minute later, and the feed showed two "ranked" rows for one
             * watch — 8.3 and then 8.6.
             *
             * Nothing was broken underneath. The database has had the right rule since
             * 20260826000500: `_rank_finalize` posts `title_ranked` only `if p_new_watch
             * or not v_replaced`, so a rerank over an existing position writes no
             * activity. One `rankings` row and one `user_media` row is all that exists
             * for that season, checked directly. What produced the second activity was
             * this menu: the row that *reads* like "redo my ranking" was **Rank again**,
             * which this app defines as a second viewing (PRD §10) and which therefore
             * earns an activity by design. The product definition was correct and lived
             * only in a doc; the label invited the other reading.
             *
             * So the menu names the intent rather than the mechanism, and the three
             * modes are now each reachable and each unmistakable:
             *
             *   Adjust placement   same watch, redo the comparisons — `rerank`, no
             *                      activity, and the row this bug needed to exist.
             *   I watched it again a genuine rewatch — `again`, exactly one activity.
             *   Change your rating a different band — `rebucket` via the log sheet.
             *
             * The labels carry the whole distinction and there is no secondary line: a
             * `value` on a `SheetRow` sets beside the label on one line and truncates at
             * phone width, which is a founder decision this menu already carries. That is
             * why the rewatch row is named for what the reader did rather than for what
             * the app will do about it — a verb alone ("Rank again") cannot say whose
             * watch it is, and a sentence explaining it cannot be read.
             *
             * Nothing about the ranking maths, the score or the schema changes.
             */}
            <SheetRow
              icon="swap-vertical-outline"
              label="Adjust placement"
              // The same function the first action in the group calls, so the two doors
              // into this intent cannot drift apart in what they ask the server for.
              // See `adjustPlacement`.
              onPress={rankedBucket ? adjustPlacement : undefined}
              disabledReason={rankedBucket ? undefined : 'Loading'}
            />
            {/**
             * The explicit rewatch, and the only row in the app that declares one.
             *
             * Completing it writes exactly one new `title_ranked` activity, which is the
             * whole difference from the row above — and the reason the label now says
             * what happened rather than what the app will do about it. Two genuine
             * rewatches are still two activities; that is not a duplicate.
             *
             * `rank_again` opens the session **over** the position the title already
             * has, so nothing the reader can see moves until they finish: close the
             * sheet, lose the network, kill the app, and the score, band and place are
             * where they were. The bucket passes straight through from
             * `rankings.bucket`, so this row decides no rating.
             */}
            <SheetRow
              icon="repeat-outline"
              label="I watched it again"
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
                        // Only a film or a season is ever ranked; a series has no menu.
                        kind: title.kind === 'season' ? 'season' : 'movie',
                        mode: 'again',
                      });
                    }
                  : undefined
              }
              disabledReason={rankedBucket ? undefined : 'Loading'}
            />
            {/* The third intent: a different *band* — loved, fine, not for me — which is
                a correction to an opinion already recorded rather than a second viewing.
                It writes no new activity and does not surrender the current position
                while it runs. */}
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
      {/* Mounted only while open, like every sheet here: it runs a per-member
          taste_match on mount, which is exactly the read to not keep warm. */}
      {followingRatingsOpen ? (
        <FollowingRatingsSheet
          mediaItemId={title.id}
          titleName={displayTitle ?? title.title}
          viewerId={profile.id}
          onPressPerson={(username) => {
            // Close first: a route change behind an open Modal leaves the sheet in
            // front of the screen it navigated to (`RecommendationRequestsSheet`).
            setFollowingRatingsOpen(false);
            router.push(`/u/${username}`);
          }}
          onClose={() => setFollowingRatingsOpen(false)}
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

/**
 * How long the thing is, in whichever unit its kind is measured in.
 *
 * `145 min` for a film, `9 episodes` for a season, and nothing at all for a series —
 * neither number a series could print is the truth, since the rankable unit is the
 * season (PRD §10) and a series' total episode count is not what anybody is deciding on.
 *
 * **Zero is not one and not none.** A season TMDB reports as having no episodes has not
 * aired, and `0 episodes` on this line reads as a fact about the show rather than as data
 * nobody has yet, so it is omitted like every other missing segment. That rule and the
 * `episode_count` column are `20260820000400`'s, and `feed/activity.ts` applies the same
 * one to a feed card's subheading.
 *
 * The spelling differs from the feed's on purpose. A feed row prints `148m` because it is
 * a row with two lines and a poster; the title page has a line to itself, and `145 min`
 * is what the founder's redesign specifies for it.
 */
function lengthOf(
  kind: 'movie' | 'season' | 'series',
  runtimeMinutes: number | null | undefined,
  episodeCount: number | null | undefined,
): string | null {
  if (kind === 'movie') {
    return positive(runtimeMinutes) ? `${Math.trunc(runtimeMinutes as number)} min` : null;
  }
  if (kind === 'season') {
    if (!positive(episodeCount)) return null;
    const count = Math.trunc(episodeCount as number);
    return `${count} ${count === 1 ? 'episode' : 'episodes'}`;
  }
  return null;
}

/** A number worth printing. See {@link lengthOf} for why zero is excluded. */
const positive = (value: number | null | undefined): boolean =>
  typeof value === 'number' && Number.isFinite(value) && value > 0;

/**
 * A watch date on the identity line — `12 Feb 2026`.
 *
 * The same UTC-pinned construction the Details panel uses, with a short month: a bare
 * `new Date('2026-02-12')` is midnight UTC and renders as the day before west of
 * Greenwich, and this sits in a caption beside an ordinal rather than under a heading
 * with room for `February`.
 */
function formatShortDate(date: string | null) {
  if (!date) return null;
  return new Date(`${date}T00:00:00Z`).toLocaleDateString(undefined, {
    timeZone: 'UTC',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
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

/**
 * An episode's air date, short.
 *
 * The same UTC-pinned construction `formatDate` uses — a bare `new Date('2013-06-02')`
 * is midnight UTC and renders as the day before west of Greenwich — with a short month
 * because this sits on a metadata line beside a runtime rather than under a Details
 * heading with room to spare.
 *
 * Null passes straight through, and the row drops the half of the line it would have
 * filled. An unaired episode with no announced date is the ordinary case, not an error.
 */
function formatAirDate(date: string | null) {
  if (!date) return null;
  return new Date(`${date}T00:00:00Z`).toLocaleDateString(undefined, {
    timeZone: 'UTC',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

/**
 * How far the poster rises into the hero.
 *
 * Raised from 64 with the taller hero, then to 120 in the hierarchy pass, and reduced to
 * 88 with the poster itself (2026-09-07). The framed poster is 140pt tall at `md`, so the
 * lift decides how much of it hangs *below* the artwork — 52pt here — and the identity
 * column beside it hangs from the same lower edge. A lift deeper than the poster is tall
 * would put its top above the page, which is why this and the collapsed band move together.
 *
 * The founder's original note was that the poster sat "beneath a separate strip" rather
 * than in the artwork, and it still does not: it straddles the fade, on its Paper mat,
 * which is the one object on this page allowed to cross the boundary.
 */
const POSTER_LIFT = 88;

/**
 * How much warm band sits *below the navigation* when a title has no artwork at all.
 *
 * The seed catalogue ships without posters or backdrops, so this is a real state and not
 * a failure one — it draws no grey box and never a poster stretched to fill. It is the
 * poster's own lift, so the poster still overlaps something and the page does not become
 * a different design; the bar's height is added to it at the call site, because the
 * navigation overlays the band and a band shorter than the bar would put the poster's top
 * underneath the back control.
 */
const HERO_COLLAPSED_BAND = POSTER_LIFT;
/**
 * Over how many points the navigation finishes becoming a header.
 *
 * The last stretch of the hero's own height, so the ground has arrived by the time the
 * artwork has. Short enough that the transition reads as a response to the scroll rather
 * than as a slow dissolve, long enough that it is a fade and not a switch — which is the
 * whole of the founder's objection to the boolean it replaces.
 */
const REVEAL_WINDOW = 96;

const styles = StyleSheet.create({
  content: { paddingBottom: theme.space[10] },
  identity: {
    flexDirection: 'row',
    // Baselines, not centres: the poster is the dominant object and the identity beside
    // it hangs from its lower edge, which is where the page resumes.
    alignItems: 'flex-end',
    gap: theme.space[4],
    paddingHorizontal: theme.layout.gutter,
    marginTop: -POSTER_LIFT,
  },
  /** The poster and the score that is anchored to it, as one object. */
  posterColumn: { position: 'relative' },
  /**
   * The score, over the poster's lower outside corner.
   *
   * Overlapping rather than inside or beside: a badge fully within the frame is a sticker
   * on the artwork, and one fully outside is back to being the detached number the
   * founder rejected.
   *
   * The offsets are bounded by what is next to it. `right` is less than the row's own
   * `space[4]` gap, so the badge crosses the poster's edge into the gutter between the
   * poster and the identity column and stops short of the text — a wider overhang would
   * be painted over by the column, which is a later sibling. `bottom` is small for the
   * same reason downwards: the `YOU` pill hangs below the badge, and the action group
   * beneath the row carries the clearance for it.
   *
   * `box-none` on the wrapper so only the badge itself takes touches: the anchor is a
   * positioning device and must not become a second, invisible target beside the poster.
   */
  scoreAnchor: { position: 'absolute', right: -12, bottom: -8 },
  /**
   * Everything that names the title.
   *
   * `flex: 1` so it takes the width the poster leaves and a long name wraps inside it
   * rather than pushing the row wider than the gutters allow. Bottom-aligned with the
   * poster through the row's own `flex-end`, so a one-line film title and a wrapped
   * three-line one both finish level with the artwork.
   */
  identityCopy: { flex: 1, gap: theme.space[1], paddingBottom: theme.space[1] },
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
  /**
   * "Recommended by Ada · 2d ago", as an object on the page.
   *
   * Solid rather than translucent, because legibility over a photograph cannot depend on
   * what the photograph happens to be — the overlay variant below sits on artwork.
   */
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
  block: {
    paddingHorizontal: theme.layout.gutter,
    paddingTop: theme.space[3],
    gap: theme.space[1],
  },
  /**
   * **The page's one hairline** (founder, 2026-09-07).
   *
   * Every other rule on this screen is gone — above the scores, above Where to watch,
   * between every pair of episodes — because a page that draws a rule at every seam has
   * told the reader nothing about which seams matter. This one is kept because the tab
   * row is the one place the page genuinely changes mode: above it the page is about the
   * title, below it the page is a set of lists you choose between.
   *
   * Doubled, because a single `hairlineWidth` rounds away to nothing on some Android
   * densities — the reason every rule in this app is drawn that way.
   */
  tabs: {
    marginTop: theme.space[6],
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
  footer: {
    paddingHorizontal: theme.layout.gutter,
    paddingTop: theme.space[6],
    gap: theme.space[1],
  },
  // Reveals the rest of a long season. Full-width and gutter-aligned so it reads as
  // the continuation of the list rather than as a control floating beside it.
  showAll: {
    paddingHorizontal: theme.layout.gutter,
    minHeight: theme.layout.minTapTarget,
    justifyContent: 'center',
  },
  pressed: { opacity: 0.7 },
});
