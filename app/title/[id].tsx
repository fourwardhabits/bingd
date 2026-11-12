import { Ionicons } from '@expo/vector-icons';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Stack,
  useIsFocused,
  useLocalSearchParams,
  useRouter,
  type ErrorBoundaryProps,
} from 'expo-router';
import { cloneElement, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Animated,
  Dimensions,
  Linking,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  View,
  useWindowDimensions,
  type LayoutChangeEvent,
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
  asRankingCategory,
  CATEGORY_NAME,
  useLoggedCollection,
  type RankingCategory,
} from '@/features/collection/use-collection';
import { useMyScores, useTitleScore } from '@/features/collection/use-score';
import { TitleRowActions } from '@/features/collection/TitleRowActions';
import { useWatchlistToggle } from '@/features/collection/use-watchlist-toggle';
import { rankingStateOf, resumeSubject } from '@/features/collection/ranking-state';
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
import {
  RankingSheet,
  type RankingSubject,
  type UpdateShowLink,
} from '@/features/ranking/RankingSheet';
import { LogAnotherWatchSheet } from '@/features/watch-history/LogAnotherWatchSheet';
import { useWatchCount } from '@/features/watch-history/use-watch-history';
import { hasHistory, watchCountLabel } from '@/features/watch-history/watch-history';
import { AddToListSheet } from '@/features/lists/AddToListSheet';
import { RecommendSheet } from '@/features/recommendations/RecommendSheet';
import { useSeasons } from '@/features/search/use-title-search';
import { useCommunityScore } from '@/features/title/use-community-score';
import { useFollowingScore } from '@/features/title/use-following-score';
import { FollowingRatingsSheet } from '@/features/title/FollowingRatingsSheet';
import { GenreRow } from '@/features/title/GenreRow';
import { Synopsis } from '@/features/title/Synopsis';
import { RANK_LABEL, TitleActions, titleActionsFit } from '@/features/title/TitleActions';
import { ImmersiveHero } from '@/features/title/ImmersiveHero';
import { directedBy } from '@/features/title/directors';
import { ImmersiveScores } from '@/features/title/ImmersiveScores';
import { useTitleLayout, useTitleLayoutResolved } from '@/features/title/title-layout';
import { NAV_BAR_HEIGHT, TitleTopBar } from '@/features/title/TitleTopBar';
import { HERO_COLLAPSED_BAND, REVEAL_WINDOW } from '@/features/title/use-hero-reveal';
import { StatusBar } from 'expo-status-bar';
import { WhereToWatch } from '@/features/title/WhereToWatch';
import { GenreLine } from '@/features/title/GenreLine';
import { TrailerRail } from '@/features/title/TrailerRail';
import { trailerPreviewsByDefault } from '@/features/title/trailer-previews';
import { useCredits } from '@/features/title/use-credits';
import { seasonListIsStale, useTitleEnrichment } from '@/features/title/use-enrichment';
import { ReviewsPreview, TitleReviews } from '@/features/title/TitleReviews';
import { useTitleVideos } from '@/features/title/use-title-extras';
import {
  DEFAULT_REVIEW_SORT,
  isRatingOrder,
  orderByRating,
  reviewsComplete,
  serverSortOf,
  useSetReviewHelpful,
  useTitleReviewCount,
  useTitleReviews,
  type ReviewOrder,
  type TitleReview,
} from '@/features/title/use-title-reviews';
import { EpisodeRail } from '@/features/title/EpisodeRail';
import { useSeasonEpisodes } from '@/features/title/use-season-episodes';
import { useSimilarTitles } from '@/features/title/use-similar-titles';
import { formatShortDate } from '@/lib/dates';
import { diagnose } from '@/lib/diagnose';
import { heroArtwork } from '@/lib/hero';
import { languageName } from '@/lib/language';
import { track } from '@/lib/analytics';
import { hapticSelection } from '@/ui/haptics';
import { avatarUri, posterUri, profileUri, videoUri } from '@/lib/images';
import { resolveMetadata } from '@/lib/media-metadata';
import { queryKeys } from '@/lib/query';
import { supabase } from '@/lib/supabase';
import { ReportSheet } from '@/features/moderation/ReportSheet';
import { RecommendationCard } from '@/features/recommendations/RecommendationCard';
import { RecommendersSheet } from '@/features/recommendations/RecommendersSheet';
import { useMarkRecommendationOpened } from '@/features/recommendations/use-sent-to-you';
import {
  useTitleRecommendations,
  type TitleRecommendation,
} from '@/features/recommendations/use-title-recommendations';
import { compactName } from '@/lib/titles';
import {
  Avatar,
  CastStrip,
  EmptyState,
  LoadingScreen,
  Poster,
  PosterGrid,
  Screen,
  ScreenError,
  ScoresSection,
  SectionHeader,
  SegmentedTabs,
  Sheet,
  SheetDone,
  SheetRow,
  SkeletonRow,
  usePullRefresh,
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

type Tab = 'episodes' | 'cast' | 'reviews' | 'videos' | 'details' | 'seasons' | 'similar';
/** Cast portraits the immersive preview fits across a 360pt screen; See all past it. */
const CAST_VISIBLE = 4;
/** How many the preview strip holds before the sheet takes over. */
const CAST_PREVIEW = 10;
/**
 * Similar on the Cinematic page before See more: two rows of three (final title
 * refinement, 2026-11-06). The rest of the same nine follow in place.
 */
const SIMILAR_PREVIEW = 6;
/**
 * Between two Cinematic sections: from one body's end to the next heading. 28pt since the
 * marquee cohesion sprint (2026-11-07; 20pt before): the founder asked for more air between
 * sections and none inside them, so the heading-to-body gaps are unchanged. Never less than
 * a tight heading action's upward slop, which lies in it (`TIGHT_SLOP.top`).
 */
const SECTION_SEAM = theme.space[7];
/**
 * The Cinematic module's 28pt title grows with the system text size only to 1.3×, the type
 * scale's ceiling for display type (title-page sprint, 2026-11-06): at 2× a long first
 * word such as "Everything" no longer fits a 320pt phone's line and broke mid-word.
 */
const TITLE_MAX_SCALE = 1.3;
/**
 * The one joiner in the identity block: space, middle dot, space.
 *
 * Written down once because the founder's grammar lock is that all three lines below the
 * title read as one statement — `Season 1 · 24 episodes · 2024`, `TV-MA · Craig Mazin`, `#2 in TV ·
 * Watched Aug 17, 2026`. The subtitle used a comma until 2026-09-07, which made two
 * adjacent lines of the same metadata look like two different kinds of claim.
 *
 * Every line that uses it is assembled by filtering first, so a missing segment can never
 * leave a stray separator at either end.
 */
const SEP = ' · ';

/**
 * What holds the personal-context line's height while there is nothing to say.
 *
 * Written as an escape rather than typed as itself: an invisible character in source is
 * one careless "strip trailing whitespace" away from becoming an empty string, and the
 * failure would be a layout jump nobody could see in the diff.
 */
const ZERO_WIDTH = '\u200B';

/**
 * How many lines the identity heading takes before it truncates (founder lock,
 * 2026-09-07).
 *
 * Two, and the type does **not** shrink to avoid reaching it. A serif display face set
 * smaller to fit a long name gives a page whose heading is a different size on every
 * title, which reads as a bug rather than as a fit; three lines of `title1` in a 242pt
 * column push the metadata and the whole action row down past the poster.
 *
 * `The Wolf of Wall Street` sets on exactly two. Longer names lose their tail, which is
 * the honest trade: the compact navigation bar carries the full name once the reader
 * scrolls past the hero, so nothing is unreachable.
 */
const TITLE_LINES = 2;

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
   * The title, and nothing else.
   *
   * Who recommended it used to ride in the link as well — `recBy` and `recAt`, set by a
   * tap in Sent to you and by nothing else — on the reasoning that the fact belonged to
   * the navigation. The recommendation note (20260929000100) reversed that: the page
   * now asks `title_recommendations_for_me` however the reader arrived, because a push
   * or an inbox tap is exactly where the note most needs to be seen.
   */
  const { id } = useLocalSearchParams<{ id: string }>();
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
  const { width: screenWidth, height: screenHeight, fontScale } = useWindowDimensions();
  const hasId = Boolean(id);
  const [watchlistBusy, setWatchlistBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  // Null until the reader picks one, so the default is whatever the tab row leads with
  // rather than a name fixed before the title is known. It was `'cast'`, which meant a
  // series settled on Cast the moment its credits arrived — after briefly showing the
  // seasons, because the fallback below had nothing else to choose while cast was empty.
  // A page that changes tab by itself a second after opening is worse than one that
  // opens on the wrong tab.
  const [tab, setTab] = useState<Tab | null>(null);
  /**
   * **Original or Immersive** (Immersive Scroll experiment, 2026-11-04). A device choice,
   * `original` unless a tester opted in, and always `original` in production — see
   * `title-layout.ts` and `docs/release/immersive-title-experiment.md`. It chooses a layout
   * and nothing else: every read, handler and sheet below is shared by both.
   */
  const immersive = useTitleLayout() === 'immersive';
  /**
   * Whether this device's title-page choice is known yet. The Cinematic page is the default,
   * so until a saved Original has been read the default can be drawn; the trailer stills,
   * the page's one request to a third party, wait for this (independent review, release
   * pass, 2026-11-07).
   */
  const layoutResolved = useTitleLayoutResolved();
  /**
   * Whether this title is the screen on top. The light status bar below is drawn only then:
   * a title stays mounted under a profile or a list pushed over it, and an override that
   * outlived its focus left white status glyphs on that screen's Paper (Codex review,
   * 2026-11-04).
   */
  const focused = useIsFocused();
  /** The first screen's measured height, which decides when the bar turns solid. */
  const [immersiveHeight, setImmersiveHeight] = useState(0);
  /**
   * The two Cinematic sections that open in place rather than opening anything (final
   * title refinement, 2026-11-06): Similar past its first six, and More details.
   */
  const [similarExpanded, setSimilarExpanded] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  /**
   * Whether the Trailers section draws YouTube's thumbnails on this page. Each one is a
   * request to `i.ytimg.com`. Starts at `trailerPreviewsByDefault`, which is `true` in every
   * lane on this branch; production runs the Show previews opt-in until that change ships
   * (gated on F-6, see `trailerPreviewsByDefault`).
   */
  const [trailerPreviews, setTrailerPreviews] = useState(trailerPreviewsByDefault);
  /** The full cast, in a sheet, from the immersive Cast preview's See all. */
  const [castOpen, setCastOpen] = useState(false);
  /** Where the immersive module's top edge sits; the top bar's reveal ends there. */
  const [immersiveModuleTop, setImmersiveModuleTop] = useState(0);
  /**
   * **The page's visible height**, from its scroll view (UI cohesion pass, 2026-11-06): the
   * Cinematic hero's sharp band grows toward a share of it on a tall phone. Measured rather
   * than read from the window, so the status bar, the navigation bar and the bottom inset
   * the screen keeps are all already accounted for.
   */
  const [viewportHeight, setViewportHeight] = useState(0);
  /** The page's scroller, for the opening screen's chevron. */
  const pageScroller = useRef<ScrollView>(null);
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
  /**
   * **Update Show in progress** (founder brief §5, 2026-11-14): the show whose correction a
   * season's reveal just opened, and the season placement that offered it. Held from the
   * reveal's Update Show to the show's band choice, and handed to the ranking subject
   * there, so the server records the link and posts nothing for the show. Cleared the
   * moment the reader leaves that sheet without choosing: an abandoned Update Show keeps
   * the show's ranking exactly where it was, and carries nothing into a later correction.
   */
  const [pendingShowLink, setPendingShowLink] = useState<{
    showId: string;
    linkedPlacementId: string;
  } | null>(null);
  /**
   * *Log another watch* (§J.3), which is now a **watch** and then an optional re-check.
   *
   * It used to open the ranking sheet directly in `mode: 'again'` — a forced full re-rank
   * that recorded no watch and no date (§C.3.2). The sheet below records the viewing
   * first, and hands the ranking sheet the event id only if the reader asks for the
   * re-check, so the two halves reach one feed activity rather than two (§K).
   *
   * **Three states rather than a boolean.** `leaving` is the sheet still on screen and
   * sliding out after *Re-check placement*: the ranking sheet may not be presented until
   * that dismissal has finished, so the phase keeps the component mounted long enough
   * for `onDismissed` to arrive. See the mount site.
   */
  const [rewatchPhase, setRewatchPhase] = useState<'closed' | 'open' | 'leaving'>('closed');
  /**
   * The viewing just saved and the band the reader chose for it, held across the sheet's
   * dismissal so the comparisons open for exactly that pair.
   */
  const pendingRecheck = useRef<{ watchEventId: string; bucket: RankingSubject['bucket'] } | null>(null);
  // Top by default, which is the founder's choice: a first-time reader wants the
  // review other people found worth reacting to, not the one written most recently.
  // The Cinematic Editorial sheet may also choose Rating, which reads Top and re-orders it.
  const [reviewSort, setReviewSort] = useState<ReviewOrder>(DEFAULT_REVIEW_SORT);
  /**
   * The Cinematic Editorial Reviews sheet (post-QA sprint 2, 2026-11-05), and a write
   * asked for from inside it: the sheet closes first and the log sheet opens after it has
   * gone, so two modals are never presented at once — the rewatch hand-off's rule.
   */
  const [reviewsOpen, setReviewsOpen] = useState(false);
  const pendingReviewWrite = useRef(false);
  const [recommending, setRecommending] = useState(false);
  /**
   * The ⋯ menu: add to a list, change the rating, drop it, or remove the title.
   *
   * It opens for **every** title since Lists v1 (§P.4) — `Add to list…` is the one row
   * that applies whether or not this account has ever touched the thing.
   */
  const [managing, setManaging] = useState(false);
  /** `Add to list…`, opened from the menu above. */
  const [addingToList, setAddingToList] = useState(false);
  /**
   * Where the ⋯ menu was closed on its way to, or null for an ordinary close.
   *
   * A ref rather than state, so remembering the destination costs no render — see the
   * `onDismissed` on the menu's `Sheet` for why the hand-off is serialised on iOS at
   * all. **Two destinations now**: `Add to list…` (Lists §P.4) and *Log another watch*
   * (§J.3), which is why this is a named destination rather than one boolean each. A
   * second boolean is how two of these come to be set at once.
   */
  const menuHandoff = useRef<'list' | 'rewatch' | null>(null);
  /**
   * The menu is closed but still on screen, on its way to another sheet.
   *
   * **A `Sheet` that is unmounted never reports its dismissal.** `onDismissed` is a
   * `Modal` callback and this menu is mounted conditionally, so closing it by dropping
   * `managing` to false tore the modal out of the tree and took the hand-off waiting on
   * that callback with it. Measured rather than reasoned about: with the menu unmounted on
   * the tap, `Add to list…` opened **nothing at all** on iOS, and so did *Log another
   * watch*. Keeping it mounted and merely invisible for the length of the slide-out is
   * what lets the callback arrive; `Sheet` renders no modal host once `visible` is false
   * and the dismissal has finished.
   */
  const [menuLeaving, setMenuLeaving] = useState(false);
  /** The people behind the Following score (§13), opened from the Scores section. */
  const [followingRatingsOpen, setFollowingRatingsOpen] = useState(false);
  /** Whom this title was last recommended to, which is the confirmation. */
  const [recommendedTo, setRecommendedTo] = useState<string | null>(null);
  /**
   * The recommendation card's two sheets, as **one** value (20260929000100).
   *
   * `all` is the list of everybody who recommended the title; `report` files a report on
   * one note. Reporting from inside the list is a sheet-to-sheet handover, which iOS
   * refuses unless the first has finished dismissing (`Sheet`'s `onDismissed`), so
   * `handoff` is the list closing with a report waiting behind it. One union rather than
   * two booleans, which is the rule `bingd-two-modals-is-the-dead-end` exists for.
   */
  const [recSheet, setRecSheet] = useState<
    { kind: 'all' } | { kind: 'handoff'; id: string } | { kind: 'report'; id: string } | null
  >(null);

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
          // `note_updated_at` for the immersive Reviews tab's "Your review" date.
          .select('bucket, watched_on, note, note_has_spoilers, note_visibility, note_updated_at')
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
   * How many viewings the reader has of this title (§J.2), for the personal-context
   * line far below.
   *
   * **Declared up here with the other title-scoped reads, not beside the line it
   * feeds.** There are early returns between this point and that one — loading, error,
   * not-found — and a hook after them is called in a different order on different
   * renders. ESLint caught it; the device symptom would have been a crash on the first
   * title that failed to load.
   */
  const watchCount = useWatchCount(profile.id, titleId ?? '');
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
  const reviews = useTitleReviews(
    data?.title?.kind === 'series' ? null : titleId,
    serverSortOf(reviewSort),
  );
  /**
   * The Most Helpful list, for the Cinematic Editorial page's Reviews preview and for the
   * sheet's Rating order, which re-orders it (post-QA sprint 2, 2026-11-05).
   *
   * The same query key the sheet's default order reads — `['title-reviews', id,
   * 'top_desc']` — so it is one cache entry, one request, and the one every Helpful
   * vote and every collection change already updates and invalidates. It replaces the
   * "From your circle" read: the preview supersedes that line, and Following stays a
   * filter inside the sheet.
   */
  const helpfulReviews = useTitleReviews(
    immersive && data?.title?.kind !== 'series' ? titleId : null,
    'top_desc',
  );
  /**
   * The number on the tab, read separately from the list.
   *
   * A series has no reviews of its own -- it cannot be ranked, so nobody has a score to
   * review it with -- and passing null keeps the read from being issued at all rather
   * than issuing one that is guaranteed to answer zero.
   */
  const reviewCount = useTitleReviewCount(
    data?.title?.kind === 'series' ? null : titleId,
  );
  const setHelpful = useSetReviewHelpful(titleId);
  const community = useCommunityScore(titleId, profile.id);
  const following = useFollowingScore(titleId, profile.id);
  const watched = useWatched(profile.id);
  /**
   * Who recommended this to the reader, and what they said (20260929000100).
   *
   * Asked of any title (a whole show too, since 2026-11-14), and only once the
   * reader's own state is known and says they have not ranked it: a ranked title is not a
   * recommendation any more, which is the rule Sent to you already keeps. The same gate
   * applies to what is drawn, so a card seeded by a Sent to you tap cannot flash on a
   * title that turns out to be ranked.
   */
  // Every kind since 2026-11-14: a whole show is rankable in its own pool, so it can be
  // recommended like a film or a season (recommend_title resolves it the same way).
  const recommendable = Boolean(data.title?.kind);
  const askRecommendations = hasId && recommendable && personal.isSuccess && !data.ranked;
  const recommendations = useTitleRecommendations(profile.id, id ?? '', askRecommendations);
  // Memoised, because the effect below depends on it: a fresh `[]` on every render would
  // make "is there anything unopened here" a question asked on every frame.
  const recommendationRows = useMemo(
    () =>
      askRecommendations
        ? (recommendations.data ?? NO_RECOMMENDATIONS)
        : NO_RECOMMENDATIONS,
    [askRecommendations, recommendations.data],
  );
  const markRecommendationOpened = useMarkRecommendationOpened(profile.id);
  /**
   * Seeing the card is opening the recommendation, however the reader got here — which is
   * what finally marks an inbox or push open, where only a Sent to you tap used to. Once
   * per row per screen; the server refuses to move a timestamp it already has, and the
   * mutation reports the analytics event once per row per process.
   */
  const markedHere = useRef(new Set<string>());
  const openedKind = data.title?.kind === 'season' ? 'tv_season' : 'movie';
  useEffect(() => {
    for (const row of recommendationRows) {
      if (row.openedAt || markedHere.current.has(row.id)) continue;
      markedHere.current.add(row.id);
      markRecommendationOpened.mutate({
        recommendationId: row.id,
        mediaKind: openedKind,
        hasNote: Boolean(row.message),
        surface: 'title',
      });
    }
  }, [recommendationRows, markRecommendationOpened, openedKind]);
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
  const showsEpisodes =
    data?.title?.kind === 'season' && (immersive || tab === null || tab === 'episodes');
  const episodes = useSeasonEpisodes(titleId, showsEpisodes && !enriching);
  /**
   * The Similar tab's data, when it is the tab being shown.
   *
   * **On a film, Similar is the default** (founder, 2026-09-13): it leads a movie's tab
   * row, and `activeTab` falls back to the head of that row, so a reader who has chosen
   * nothing is looking at it. That is the Episodes gate's shape exactly, and for the same
   * reason: waiting for `tab` to be set would make the default tab the one tab that never
   * loaded. So a film page asks for its similar titles on arrival — one read of a
   * week-long cached facet in the ordinary case, and the provider only when it is cold.
   *
   * On a season and a series Similar is **second**, after Episodes and Seasons, so
   * `tab === null` never means it there and nothing is fetched until it is chosen.
   *
   * Read off `data.title.kind` rather than `activeTab`, which is not computed yet at this
   * point in the render — the constraint the Episodes gate above works under too.
   *
   * The parent's id is the facet's owner for a season — TMDB publishes recommendations
   * for a series and none for a season — and `use-similar-titles.ts` has the whole
   * argument. A season whose parent embed did not come back passes null, which the hook
   * resolves by asking the adapter rather than by giving up: the server takes a season
   * id, finds the parent and says which row it wrote the facet against.
   */
  const showsSimilar =
    immersive || tab === 'similar' || (tab === null && data?.title?.kind === 'movie');
  const similar = useSimilarTitles({
    sourceId: titleId,
    kind: data?.title?.kind ?? null,
    // `parentOf`, because PostgREST hands a `!inner`-less embed back as an object here
    // and as a one-element array under other generated types — the same normalisation
    // the identity block does at `const parent =` below.
    facetId: data?.title?.kind === 'season' ? (parentOf(data.title.parent)?.id ?? null) : titleId,
    userId: profile.id,
    enabled: showsSimilar,
  });
  /**
   * Pull to refresh, and **only** pull to refresh.
   *
   * This was `refreshing={seasons.isRefetching || personal.isRefetching}`, which is the
   * founder's "the page behind the review sheet jumps" defect on physical build 9.
   * `personal` is keyed under `queryKeys.title(id)`, the log sheet's note autosave
   * invalidates that prefix while somebody is typing, and iOS reads `refreshing: true` as
   * a *programmatic pull* — it grows the scroll view's top content inset and animates the
   * content down to meet it, which is the blank band above the hero, and back up when the
   * refetch settles. `use-pull-refresh.ts` carries the whole trace.
   *
   * **It moved below the Similar tab's hook so that it could include it**, which is not a
   * tidy-up: the Similar tab's empty and failed states both say "pull down to try again",
   * and that sentence was a promise nothing kept. `useSimilarTitles` returns a `refetch`
   * that does nothing while the tab is closed, so a pull from Cast still spends nothing —
   * the gate stays inside the hook that owns it rather than being restated here.
   */
  const pull = usePullRefresh(
    // Memoised, because the hook's callback depends on it: a new array-builder every
    // render would hand `RefreshControl` a new `onRefresh` on every re-render of this
    // page.
    useCallback(
      () => [refetch(), seasons.refetch(), personal.refetch(), similar.refetch()],
      [refetch, seasons, personal, similar],
    ),
  );
  // The score is derived from the band, so this needs the whole category's
  // bucket counts — not just this title's row (ranking.md §11).
  const rankCategory: RankingCategory = asRankingCategory(data?.ranked?.category);
  const titleScore = useTitleScore(profile.id, rankCategory, data?.ranked ?? null);
  /**
   * The ranked list this title sits in, for the hero's one rank line.
   *
   * Already cached — Collection and Profile read the same key — so on the ordinary
   * path this costs nothing, and it is what lets the rank context be derived rather
   * than fetched. Only fetched at all once we know the title is ranked.
   *
   * That sentence was not true until 2026-09-16: with no `enabled`, every title page
   * (most of them unranked, opened from Search, For You or a friend's activity) re-read
   * the reader's whole ranked library with its catalogue embed once the cache was a
   * minute old, and threw it away. A 700-title import paid for 700 rows per title
   * opened, and a ranked season read Movies first because `rankCategory` defaults to it
   * before the page's own read lands.
   */
  const rankedList = useRankedCollection(profile.id, rankCategory, {
    enabled: Boolean(data?.ranked),
  });

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
   * The season rows' own controls (TV show & season ranking, 2026-11-14): each season's
   * score circle comes from the reader's scores, which `useMyScores` computes per ranking
   * pool, so a season's number is always against seasons and never against shows. The
   * bookmark is the same one-tap Watchlist Search rows carry.
   */
  const myScores = useMyScores(profile.id, isSeriesTitle);
  const seasonWatchlist = useWatchlistToggle(profile.id, 'title');
  /** Each season's logged bucket, so a season row's `+` can resume an unfinished placement. */
  const loggedForSeasons = useLoggedCollection(profile.id, { enabled: isSeriesTitle });

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
  const parent = parentOf(title.parent);
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
    (immersive
      ? immersiveModuleTop || immersiveHeight || Math.round(screenHeight * 0.3)
      : hero.uri
        ? screenWidth / theme.layout.aspect.backdrop
        : collapsedHero) - barHeight,
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
  // Ranked, unfinished (a bucket chosen here, comparisons never completed) or neither —
  // the same `rankingStateOf` Search, Collection and list rows ask. Internal only: the page
  // draws Rank or Ranked, and `rank` uses it to resume (founder, 2026-09-21).
  const rankState = rankingStateOf({ ranked: Boolean(data.ranked), bucket: data.logged?.bucket });
  const noteText = (data.logged?.note ?? '').trim();
  const hasReview = Boolean(noteText) && data.logged?.note_visibility === 'public';
  const hasPrivateNote = Boolean(noteText) && data.logged?.note_visibility !== 'public';

  /** The band this title is already in, in the chips' spelling. Null until the read lands. */
  const rankedBucket = data.ranked?.bucket ? (BUCKET_IDS[data.ranked.bucket] ?? null) : null;

  const rankCategoryLabel = CATEGORY_NAME[rankCategory];
  // One line only, chosen by the founder's rule: top ten overall, else the
  // strongest category placement. Derived from rows already cached.
  const heroRank = data.ranked
    ? heroRankFor(title.id, rankedList.data ?? [], rankCategory)
    : null;
  const { score, total } = titleScore;
  // Every kind (2026-11-14): a film, a whole show and a season are each ranked in their
  // own pool. A show's score is its own explicit ranking, never its seasons'.
  const rankable = title.kind === 'movie' || title.kind === 'season' || title.kind === 'series';
  const isSeries = title.kind === 'series';
  const isSeason = title.kind === 'season';
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
   * `Season 2 · 7 episodes · 2025`, or `2013`.
   *
   * **A season's length sits here, between its number and its year** (founder hotfix,
   * 2026-11-07): season number, episode count, then year, in that order, on both layouts.
   * The count is the season's own `episode_count` and is absent when TMDB has none (or
   * reports zero — see `lengthOf`); it is never a runtime. It moved off the metadata line
   * below, so it is said once. A series' line is unchanged: its year alone.
   *
   * **One separator for the whole identity block** (founder grammar lock, 2026-09-07).
   * It was a comma here and a middle dot on the line below, which made two adjacent lines
   * of the same metadata look like two different kinds of statement. The middle dot is
   * what the metadata line already used and it is now the block's only joiner, so
   * `Season 1 · 24 episodes · 2024` and `TV-MA · Craig Mazin` read as one grammar.
   *
   * The em-dash form the log sheet uses — "Parks and Recreation — Season 2" — is for
   * surfaces with one line to say the whole name in. Here there is a hierarchy to put it
   * in.
   */
  const lengthLabel = lengthOf(title.kind, title.runtime_minutes, title.episode_count);
  const identitySubtitle = isSeason
    ? [displayTitle ?? title.title, lengthLabel, year].filter(Boolean).map(String).join(SEP)
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
   * Then the credit, **and which credit is decided by the kind of title, with no
   * cross-fallback in either direction** (founder grammar lock, 2026-09-07).
   *
   *   film        the `Director`, or nothing.
   *   television  an explicit `Creator`, or nothing.
   *
   * It used to read `director ?? showrunner` for every kind, and on a season that is the
   * bug the founder named: the `Director` credit on a season payload is the person who
   * directed *one episode*, and the line presented them in the slot a reader reads as
   * "whose show is this". `To Kill a Monkey` and every other season page were printing an
   * episode director as a showrunner. Falling the other way is no better — a film has no
   * creator credit worth the name — so neither kind borrows the other's.
   *
   * Where the credit is missing the segment is simply absent: `TV-MA · 24 episodes` is
   * the founder's rule and it is better than a confident falsehood in the one place on
   * the page a reader has no way to check. `useCredits` narrows the television answer to
   * `Creator` for the same reason.
   *
   * Built by filtering, so a missing part never leaves a stray separator, and the whole
   * line is absent rather than empty when all three are: an empty `Text` is a line box
   * with the footnote's height, which reads as a gap under the title.
   */
  const credit =
    title.kind === 'movie' ? (credits.data?.director ?? null) : (credits.data?.showrunner ?? null);
  // A season's episode count is on the identity line above (`identitySubtitle`).
  const metaLine = [descriptive.certification, isSeason ? null : lengthLabel, credit]
    .filter(Boolean)
    .join(SEP);

  /**
   * The reader's own context under the metadata: where it sits, and when they saw it.
   *
   * `#2 in Movies · Watched Aug 17, 2026`.
   *
   * ---------------------------------------------------------------------------
   * IT STAYS HERE, AND IT IS THE OVERALL RANK (founder, 2026-09-07)
   *
   * The design draft proposed moving both halves into the Scores section, under `Your
   * score`. The founder cut that and the reason is what each fact is *about*: a score is
   * an aggregate, and a placement and a date are the reader's history with this title.
   * They belong beside the title, not beneath a number. They also do not fit that cell —
   * a score unit is a circle and two short lines.
   *
   * **Overall only.** `heroRankFor` answers with the top-ten overall placement where
   * there is one and otherwise with the best top-ten *genre* placement, and this line now
   * takes the first and discards the second. `#3 in Drama` beside a film's title reads as
   * that film's standing when it is really the standing of a slice the reader never
   * chose, and swapping to it precisely when the overall number is weaker is the page
   * flattering itself. Where there is no top-ten overall placement the segment is absent
   * and the line is the watch date alone.
   *
   * The genre reading is not deleted — `heroRankFor` still computes it and the
   * post-ranking reveal still uses it, which is a surface where the reader has just
   * finished the comparison that produced it.
   *
   * Built by filtering, so a title ranked outside the top ten and never dated produces no
   * line at all rather than a dangling separator.
   */
  /**
   * ---------------------------------------------------------------------------
   * **`Watched N times ›`** — founder-locked, 2026-09-19 (§J.2)
   *
   * The entry is the line that is already here. It gains a count and a chevron, and
   * nothing else on the page moves — which is the whole argument against a History tab:
   * a watch history is reader-specific and private, and it belongs with the reader's
   * other personal facts rather than in a tab row whose every other entry describes the
   * title itself and reads identically for every viewer (§J.1).
   *
   *   1 watch, dated     `#2 in Movies · Watched Aug 17, 2026 ›`
   *   1 watch, undated   `#2 in Movies ›`
   *   2 watches          `#2 in Movies · Watched 2 times ›`
   *
   * **Never `Watched 1 time`.** One viewing keeps the sentence the page already had, and
   * the plural count appears from the second watch onward — which is also the first
   * moment it says anything the date alone did not.
   *
   * The count is the reader's own and appears on nobody else's view of this title.
   */
  const countLabel = watchCountLabel(watchCount.data ?? 0);

  const watchedLine =
    countLabel ??
    (data.logged?.watched_on
      // `lib/dates.ts`, which is where this moved: it was a byte-identical local copy of
      // the formatter the Episodes tab below already used, in this same file.
      ? `Watched ${formatShortDate(data.logged.watched_on)}`
      : null);

  // The whole line is the route whenever there is a history to open, which is any seen
  // title: a single dated watch still has a date to edit and a past watch to add.
  const historyOpen = hasHistory(watchCount.data ?? 0);

  const contextLine = [
    heroRank?.basis === 'overall' ? heroRank.label : null,
    watchedLine,
  ]
    .filter(Boolean)
    .join(SEP);

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
    /**
     * Similar, straight after the entry that owns the page — and therefore **first on a
     * film** (founder, 2026-09-13).
     *
     * One position that produces all three rows the decision names, because Seasons and
     * Episodes are each present on exactly one kind and neither on a film:
     *
     *   film     Similar · Cast · Reviews · Videos · Details
     *   season   Episodes · Similar · Cast · Reviews · Videos · Details
     *   series   Seasons · Similar · Cast · Videos · Details
     *
     * The title page is where somebody explores from, and on a film nothing else on the
     * page answers "what next" — so the exploration tab leads. On a season and a series
     * the page's own unit still leads: which episode, which season. The first entry is
     * also the default (`activeTab` falls back to the head of this row), which is why
     * `showsSimilar` fetches on a film's arrival and nowhere else.
     *
     * Always present, on the same rule Reviews follows rather than the one Videos follows.
     * The answer is not knowable before it is asked — finding out is the facet read — so
     * this is a tab that may turn out to have nothing and is still worth offering, and
     * "No similar titles yet" is the honest end of that.
     */
    { id: 'similar' as const, label: 'Similar' },
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
    /**
     * The count sits in the label, which is the smallest honest fix for the founder's
     * actual complaint: the tab did not say whether opening it was worth anything.
     *
     * Only once there is something to open. A `Reviews 0` is a label that has learned to
     * say no, and it is also the state most titles are in -- the tab still appears,
     * because it is the invitation to write the first one.
     */
    ...(isSeries
      ? []
      : [
          {
            id: 'reviews' as const,
            // `Reviews (2)`: a bare `Reviews 1` read as one word and a stray digit (founder,
            // physical QA, 2026-09-14). Zero still renders `Reviews`, never `Reviews (0)`.
            label: reviewCount.data ? `Reviews (${reviewCount.data})` : 'Reviews',
          },
        ]),
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
    // Any other log sheet is not the Update Show it may have been left from: the link
    // must never ride along into an unrelated correction.
    setPendingShowLink(null);
    setLogIntent(intent);
    setOpenWriting(writing);
    setOpenSection(section);
    setPlacement(null);
    setLoggingTitle(loggable);
  };

  /**
   * **Rank, aware of where the reader left off** (founder, final UI simplification
   * 2026-09-21). The button says *Rank* either way; the internal state decides the path:
   *
   *   unranked     the ordinary flow — the log sheet and its *How was it?*.
   *   unfinished   straight back into the comparisons in the bucket already chosen.
   *                `rank_start` resumes the server's session for that bucket — the
   *                comparison on screen and every answer — so this never opens a second
   *                session and never asks the question again.
   */
  const rank = () => {
    const bucket = data.logged?.bucket;
    const resume =
      rankable && rankState === 'unfinished' && bucket ? resumeSubject(loggable, bucket) : null;
    if (!resume) {
      openLog();
      return;
    }
    setActionError(null);
    setPlacement(null);
    setRankedTitle(loggable);
    setRankingSubject(resume);
  };

  /**
   * **A season row's `+`** (TV show & season ranking, 2026-11-14): straight into ranking
   * that season, through the same log sheet and the same resume rule as Rank on its own
   * page. Tapping the row itself still opens the season's page.
   */
  const rankSeason = (season: {
    id: string;
    title: string;
    season_number?: number | null;
    release_date: string | null;
    poster_path: string | null;
  }) => {
    const seasonTitle: LoggableTitle = {
      id: season.id,
      title: season.title,
      year: yearOf(season.release_date),
      posterUri: posterUri(season.poster_path, 'card') ?? posterUri(title.poster_path, 'card'),
      kind: 'season',
      seriesTitle: title.title,
      seasonNumber: season.season_number ?? null,
    };
    const bucket = (loggedForSeasons.data?.entries ?? []).find(
      (entry) => entry.mediaItemId === season.id,
    )?.bucket;
    const state = rankingStateOf({ ranked: Boolean(myScores.data?.has(season.id)), bucket });
    const resume = state === 'unfinished' && bucket ? resumeSubject(seasonTitle, bucket) : null;
    setActionError(null);
    setPendingShowLink(null);
    setPlacement(null);
    if (resume) {
      setRankedTitle(seasonTitle);
      setRankingSubject(resume);
      return;
    }
    setLogIntent('note');
    setOpenWriting(null);
    setOpenSection(null);
    setLoggingTitle(seasonTitle);
  };

  /**
   * **Update Show, from a season's reveal**: the show's ordinary correction, the one *Edit
   * ranking* opens — its band chooser, then comparisons from where it already stands
   * (`rank_again` for the same band, `rank_rebucket` for another) — with the link held
   * until the band is chosen. On a season's page the show is its parent; on a show's page
   * (a season row's `+`) it is this page's own title.
   */
  const updateShow = (link: UpdateShowLink) => {
    const show: LoggableTitle | null =
      title.kind === 'series' && title.id === link.showId
        ? loggable
        : parent && parent.id === link.showId
          ? {
              id: parent.id,
              title: parent.title,
              year: null,
              posterUri: posterUri(parent.poster_path ?? null, 'card'),
              kind: 'series',
            }
          : null;
    setRankingSubject(null);
    if (!show) return;
    setPendingShowLink({ showId: link.showId, linkedPlacementId: link.linkedPlacementId });
    setLogIntent('note');
    setOpenWriting(null);
    setOpenSection(null);
    setPlacement(null);
    setLoggingTitle(show);
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
  /**
   * Opens the comparisons for the band the reader chose, on the viewing they just saved.
   *
   * Its own function because two paths reach it — straight across on Android, and out of
   * the rewatch sheet's `onDismissed` on iOS — and a second copy of the subject is how
   * the two come to disagree about which watch they are re-ranking.
   *
   * **The band is the one chosen in the sheet, not the one the title had** (founder QA,
   * 2026-09-21): a second viewing can change how somebody feels about a film, and the
   * ranking entry after a rewatch is the ordinary *How was it?*, asked again. `rank_again`
   * opens the session over the existing placement in whichever band it is given.
   */
  const openRecheck = () => {
    const pending = pendingRecheck.current;
    pendingRecheck.current = null;
    if (!pending) return;
    setRankedTitle(loggable);
    setRankingSubject({
      id: title.id,
      title: title.title,
      bucket: pending.bucket,
      posterUri: posterUri(title.poster_path, 'card'),
      kind: title.kind,
      mode: 'again',
      watchEventId: pending.watchEventId,
    });
  };

  /**
   * *Log another watch*, from the immersive page's *Log rewatch*. The same sheet and the
   * same `rewatchPhase` the ⋯ menu's row opens, so the iOS hand-off to the comparisons
   * (`onDismissed` → `openRecheck`) is unchanged.
   *
   * Straight to `open` on both platforms, without the menu's `menuHandoff`: that wait is
   * for the menu's own dismissal, and a button on the page is not leaving a presented
   * sheet, so there is nothing to serialise against.
   */
  const openRewatch = () => {
    // Only from a closed sheet. While it is still sliding away after a band was chosen
    // (`leaving`, iOS), a press that reached this button would present the sheet again
    // mid-dismissal and drop the re-check that `onDismissed` is about to open. UIKit
    // normally ignores touches during the transition; this does not rely on it
    // (independent review, 2026-11-11). The ⋯ row is behind the menu, so never met it.
    if (rewatchPhase !== 'closed') return;
    setActionError(null);
    setRewatchPhase('open');
  };

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
   * **There was a third door into `rerank`, and it is gone** (founder, 2026-09-08).
   *
   * `adjustPlacement` opened a `mode: 'rerank'` session straight from the menu, behind a
   * row called *Rank it again*. The mode is untouched and still reachable — *Update your
   * rating* re-choosing the band it already has is the same `rankAgain(newWatch: false)`
   * call, made by `LogSheet` — but the menu no longer offers two rows for it. See the
   * `Ranking` group below for why one entry point is the whole of the change.
   */


  /**
   * **Rank, Save, List, Recommend: beside the poster where they fit, under it where they do
   * not** (founder, Growth UX sprint, 2026-11-02).
   *
   * Decided from the viewport rather than left to `flexWrap`, which on a 375pt phone put the
   * last glyph on a line of its own under the other three. The controls, their order and
   * their sizes do not change, only which row they sit in. Measured against the column this
   * title actually has, and at the reader's text size, so a larger setting moves the row
   * instead of breaking it.
   */
  const identityColumn =
    screenWidth -
    theme.layout.gutter * 2 -
    theme.space[4] -
    (theme.poster.detail.width + theme.space[1] * 2);
  /** The unranked word, by kind: Rank Movie, Rank Show, Rank Season (brief §8). */
  const rankLabel = RANK_LABEL[title.kind as keyof typeof RANK_LABEL] ?? 'Rank';
  const actionsBesidePoster = titleActionsFit(identityColumn, fontScale, {
    rank: rankable,
    icons: rankable ? 3 : 2,
    label: data.ranked ? 'Ranked' : rankLabel,
  });
  const actions = (
    <TitleActions
      rank={
        rankable
          ? {
              ranked: Boolean(data.ranked),
              label: data.ranked ? undefined : rankLabel,
              accessibilityLabel: data.ranked
                ? 'Ranked. Change or remove this.'
                : `Rank ${displayTitle ?? title.title}`,
              accessibilityHint: data.ranked
                ? 'Opens rating and collection options'
                : 'Opens the rating sheet',
              onPress: () => (data.ranked ? setManaging(true) : rank()),
            }
          : null
      }
      save={{
        selected: isWatchlisted,
        // The sentences the labelled control used, unchanged: a screen reader's
        // name for this control is what says which way the toggle goes.
        accessibilityLabel: isWatchlisted
          ? `Remove ${title.title} from your watchlist`
          : `Add ${title.title} to your watchlist`,
        onPress: () => void toggleWatchlist(),
        disabled: watchlistBusy,
      }}
      // One tap, beside Watchlist (founder QA, 2026-09-21). No sheet is open
      // when this is pressed, so there is nothing to serialise against.
      list={{
        accessibilityLabel: `Add ${title.title} to a list`,
        onPress: () => setAddingToList(true),
      }}
      recommend={
        rankable
          ? {
              accessibilityLabel: `Recommend ${title.title} to a friend`,
              onPress: () => {
                setActionError(null);
                setRecommendedTo(null);
                setRecommending(true);
              },
            }
          : null
      }
    />
  );

  /**
   * **The notices under the actions**, moved verbatim so both layouts draw the same ones:
   * the recommendation card, a failed action, a sent recommendation, a failed read.
   */
  const notices = (
    <>
        {recommendationRows.length > 0 ? (
          <View style={styles.block}>
            <RecommendationCard
              rows={recommendationRows}
              onOpenAll={() => setRecSheet({ kind: 'all' })}
              onReport={(recommendationId) => setRecSheet({ kind: 'report', id: recommendationId })}
            />
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
    </>
  );

  /**
   * The thumbs-up, from the sheet, the original tab or the preview alike.
   *
   * One write at a time, and a second tap while it is in flight does nothing. Not
   * throttling for its own sake: a queued mutation runs its `onMutate` immediately, so a
   * second tap would take a snapshot of the first tap's optimistic state and a double
   * failure would roll back to a mark the server never accepted. Refusing to start the
   * second write keeps exactly one optimistic change alive, which is the condition the
   * rollback in `useSetReviewHelpful` is correct under.
   */
  const toggleHelpful = (review: TitleReview) => {
    if (setHelpful.isPending) return;
    // The premium interaction vocabulary, at its quietest weight: this is a selection,
    // not an achievement.
    hapticSelection();
    setHelpful.mutate({ reviewId: review.id, helpful: !review.viewerHelpful });
  };

  /**
   * The full list of reviews: the original page's Reviews tab, and the Cinematic
   * Editorial page's Reviews sheet (post-QA sprint 2, 2026-11-05). One element, so the
   * two cannot disagree about spoilers, Helpful, reporting or who sees what.
   *
   * In the sheet, Rating is the complete Most Helpful list re-ordered by score — offered
   * only while that list is provably complete — and any other order is the server's.
   */
  const reviewList = ({ inSheet = false }: { inSheet?: boolean } = {}) => {
    /**
     * The order the sheet is actually in, used for the rows and the control alike
     * (independent review, post-QA sprint 2). Rating chosen over a list that has since
     * reached the ceiling — a refetch after a vote, say — is no longer an order this
     * sheet can honestly show, so it reads as Most Helpful, which is what it draws, rather
     * than a Rating label over a Helpful list.
     */
    const order: ReviewOrder =
      isRatingOrder(reviewSort) && !(inSheet && ratingAvailable) ? 'top_desc' : reviewSort;
    const rating = isRatingOrder(order);
    const serverRows = rating ? helpfulReviews.data : reviews.data;
    const rows = rating
      ? orderByRating(helpfulReviews.data ?? [], order === 'rating_asc' ? 'asc' : 'desc')
      : (reviews.data ?? []);
    const loading = rating ? helpfulReviews.isPending : reviews.isPending;
    return (
      <TitleReviews
          reviews={rows}
          loading={loading}
          sort={order}
          onChangeSort={(next) => {
            setReviewSort(next);
            track({ name: 'reviews_sort_changed', props: { sort: next } });
          }}
          onToggleHelpful={toggleHelpful}
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
          onPressAuthor={(handle) => {
            if (inSheet) setReviewsOpen(false);
            router.push(`/u/${handle}`);
          }}
          viewerRanked={Boolean(data.ranked)}
          viewerHasReview={(reviews.data ?? []).some(
            (review) => review.userId === profile.id,
          )}
          // One composer. A note has always been written in the log sheet, where the
          // spoiler flag and the visibility are chosen beside it; a second one here
          // would be a second content model wearing a different button.
          onWrite={inSheet ? writeFromSheet : () => openLog('review')}
          noun={title.kind === 'season' ? 'season' : 'movie'}
          // So the reporting control is absent from the viewer's own review, which
          // the server would refuse anyway.
          viewerId={profile.id}
          ratingAvailable={inSheet && ratingAvailable}
          truncated={inSheet && !reviewsComplete(serverRows)}
          // The immersive page's Reviews tab (founder phone QA, 2026-11-04): your
          // published review first, from your own row — a public note and nothing else.
          variant={immersive ? 'editorial' : undefined}
          ownReview={immersive ? ownPublishedReview : null}
        />
    );
  };

  /** Rating needs every review in hand; a list at the server's ceiling may not be all. */
  const ratingAvailable = immersive && reviewsComplete(helpfulReviews.data);

  /** Edit or Write from inside the sheet: close it, then open the one composer. */
  const writeFromSheet = () => {
    setReviewsOpen(false);
    if (Platform.OS === 'ios') pendingReviewWrite.current = true;
    else openLog('review');
  };

  /**
   * **The tab bodies, as one function both layouts call** (Immersive Scroll experiment).
   *
   * The blocks inside are the ones the tab bar always rendered, moved here unchanged:
   * `activeTab` is shadowed by the argument, so each still reads `activeTab === '…'`. The
   * original page calls it with the selected tab; the immersive page calls it once per
   * section. The two limits are the immersive previews and are absent on the original.
   */
  const tabContent = (
    which: Tab | null | undefined,
    { similarLimit }: { similarLimit?: number } = {},
  ) => {
    const activeTab = which;
    return (
      <>
        {activeTab === 'episodes' ? (
          episodes.data?.length ? (
            // One compact rail; each episode's synopsis, date and runtime are in the sheet
            // a card opens (founder hotfix, 2026-11-07). `EpisodeRail` has the argument.
            <View style={immersive ? undefined : styles.episodesTab}>
              <EpisodeRail
                episodes={episodes.data}
                seasonLabel={isSeason ? displayTitle : null}
              />
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

        {activeTab === 'reviews' ? reviewList() : null}

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
                  /**
                   * The search row's controls, unchanged (brief §3): the Maroon `+` that
                   * ranks this season directly, or its score circle once ranked, and the
                   * one-tap Watchlist. No labelled Rank button in a row; the row's own tap
                   * still opens the season.
                   */
                  trailing={
                    <TitleRowActions
                      name={`${title.title}, ${season.title}`}
                      kind="season"
                      score={myScores.data?.get(season.id) ?? null}
                      saved={seasonWatchlist.isSaved(season.id)}
                      busy={seasonWatchlist.busy === season.id}
                      onRank={() => rankSeason(season)}
                      onToggleWatchlist={() => void seasonWatchlist.toggle(season.id)}
                    />
                  }
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

        {/**
         * Similar, as one wall of artwork.
         *
         * `PosterGrid` unchanged, which is the app's established answer to "a lot of
         * titles at once" — For You and the Collection wall are the same component, and
         * three across means the nine-title budget is exactly three rows on a phone.
         * Deliberately not a labelled variant of it: the grid draws no titles on purpose
         * (its own header says why), and the name, the year and the reader's score all
         * travel in each tile's accessibility label already.
         *
         * The score chip is the Collection wall's, on a candidate the reader has ranked
         * and on nothing else. Nothing new is drawn for this tab, and the chip is the
         * only thing on this surface the reader's own history touches: the *order* is
         * TMDB's, unreranked (founder, 2026-09-12).
         *
         * Every destination is `/title/{id}` — the same push the seasons list above
         * makes and the same one every other surface in the app makes. For a film that
         * is the film; for television it is the **series**, which opens on its Seasons
         * tab and is therefore the existing series-to-season flow rather than a second
         * one. `use-similar-titles.ts` is where a season page's associations are taken
         * from its parent instead of invented for it.
         */}
        {activeTab === 'similar' ? (
          similar.tiles.length ? (
            <PosterGrid
              tiles={similarLimit ? similar.tiles.slice(0, similarLimit) : similar.tiles}
              onPressTile={(tile) => {
                track({
                  name: 'similar_title_opened',
                  props: { medium: title.kind === 'movie' ? 'movies' : 'tv' },
                });
                router.push(`/title/${tile.id}`);
              }}
            />
          ) : similar.isPending ? (
            // The same skeleton every other list on this page uses. Three rows, which is
            // the height the grid is about to be.
            <SkeletonRow count={3} />
          ) : similar.isError ? (
            /**
             * Quiet, and the page around it keeps working.
             *
             * The provider can refuse — the hourly ceiling in api.md §9 is a per-user
             * limit and this tab spends against it — and a refusal is a fact about one
             * tab. It must never reach the route's error boundary, which is why the
             * query's failure is read here rather than thrown: everything above the tab
             * row is the reader's own data and TMDB has no opinion about any of it.
             */
            <EmptyState
              kind="couldNotLoad"
              compact
              title="Could not load similar titles"
              body="Pull down to try again in a moment."
            />
          ) : (
            // A real answer rather than a failure. TMDB associates nothing with plenty of
            // obscure titles, the adapter caches that fact deliberately, and "yet" is the
            // honest word for something a later provider update could change.
            <EmptyState
              kind="nothingYet"
              compact
              title="No similar titles yet"
              body="Nothing is associated with this one."
            />
          )
        ) : null}
      </>
    );
  };
  /**
   * **The Cinematic Editorial layout** (founder-approved direction, 2026-11-04), rendered
   * instead of the original scroll content when this device opted in.
   *
   * It reads the values the original page computes above and calls the same handlers, so
   * ranking, scoring and every sheet behave identically; only the arrangement differs:
   *
   *   1. `ImmersiveHero` — a sharp backdrop, and over its lower part one Paper module
   *      holding the title, the genre line, the metadata, the director, the actions and
   *      the three scores. The module is the top of the page's Paper (title-page sprint,
   *      2026-11-06): no blurred field, no chevron, no filler height;
   *   2. then, on the same content line and with no tabs: About, Where to Watch, Episodes
   *      or Seasons where they apply, Cast, Reviews, Trailers, Details and Similar.
   *
   * No second title, poster, Rank or score block anywhere below the module.
   */
  const immersiveName = (
    <Text
      testID="title-name"
      variant="title1"
      numberOfLines={3}
      maxFontSizeMultiplier={TITLE_MAX_SCALE}
    >
      {primaryName}
    </Text>
  );
  /**
   * The same cluster as the original page, on Paper. An unranked or unfinished title keeps
   * Rank exactly as it was; a ranked one shows the smaller *Log rewatch* (founder,
   * 2026-11-10), which opens *Log another watch* directly — its score is the emphasis, in
   * the score row. *Edit ranking*, the same-watch correction this button used to
   * open, is still the ⋯ menu's first Ranking row.
   *
   * **No second, prominent Edit ranking beside it** (founder decision, 2026-11-11). Log
   * rewatch stays the primary action; the ranking correction is reached from ⋯ here and
   * from *Edit ranking* in an expanded watch on Watch History (the Watch history row
   * below opens it). Both open the same correction flow, which records no viewing.
   */
  const immersiveActions = cloneElement(actions, {
    rank: rankable
      ? {
          ranked: Boolean(data.ranked),
          label: data.ranked ? 'Log rewatch' : rankLabel,
          icon: data.ranked ? 'repeat-outline' : undefined,
          compact: Boolean(data.ranked),
          // The card is the full width less 12pt a side. Rank Season and Log rewatch are
          // never cut there: the whole cluster stays on one row, and past 1.5x text the
          // word fits itself to the row rather than wrapping the icons (2026-11-14).
          unclamped: true,
          accessibilityLabel: data.ranked
            ? `Log a rewatch of ${displayTitle ?? title.title}`
            : `Rank ${displayTitle ?? title.title}`,
          accessibilityHint: data.ranked
            ? 'Opens a sheet to record another viewing'
            : 'Opens the rating sheet',
          onPress: () => (data.ranked ? openRewatch() : rank()),
        }
      : null,
  });
  /**
   * The module's metadata line: `2023 · R · 125m`, or `Season 1 · 9 episodes · 2023 ·
   * TV-MA`. The year leads, as the brief asks. A film's director has its own quiet line
   * under it (`directedBy`); a season or series has none, because a season's Director
   * credit is an episode's and TMDB has no single director for a show.
   */
  const moduleMeta = [
    isSeason ? identitySubtitle : year ? String(year) : null,
    descriptive.certification,
    isSeason ? null : lengthLabel,
  ]
    .filter(Boolean)
    .join(SEP);
  const directorLine = title.kind === 'movie' ? directedBy(credits.data?.directors ?? []) : null;
  /**
   * The facts behind the Cinematic page's More details (final title refinement,
   * 2026-11-06), closed until asked for. Only what the module does not already say: no
   * genres or director, and a film's runtime is already on its metadata line — a season's
   * or series' line counts episodes instead, so their minutes are still news. The rank
   * keeps its denominator, which the module's short form leaves out (PRD §10).
   */
  const moreDetails = (
    [
      ['Released', formatDate(title.release_date)],
      [
        'Runtime',
        title.kind !== 'movie' && title.runtime_minutes ? `${title.runtime_minutes} minutes` : null,
      ],
      ['Original language', languageName(descriptive.language)],
      ['Created by', title.kind === 'movie' ? null : (credits.data?.showrunner ?? null)],
      [
        'Your rank',
        data.ranked && total ? `#${data.ranked.position} of ${total} in ${rankCategoryLabel}` : null,
      ],
    ] satisfies (readonly [string, string | null])[]
  ).filter((row): row is [string, string] => Boolean(row[1]));
  /**
   * One section of the Cinematic page, on the page's full width (final title refinement,
   * 2026-11-06): the heading and the body on the app's own 16pt gutter, which each
   * component already draws, rather than inside the module's 12pt inset as well. Only the
   * module is inset; below it the page is ordinary Paper, as wide as every other screen.
   *
   * **Vertically efficient.** The heading is its own line, not a 44pt row (`tight`), and
   * the body starts `gap` below it: 8pt by default, less a component's own top padding
   * where it has one, so the words under every heading start the same distance down.
   *
   * **An action's target stays off the rails.** A heading action's slop reaches into the
   * 20pt seam above and the body's 8pt padding below (`TIGHT_SLOP`), so the Cast and
   * Trailers rails carry no top padding of their own and start under that 8pt: a rail
   * still coasting from a fling cannot take a press meant for See all or Show previews
   * (independent review 2). A section with an action must keep `gap` at 8pt or more.
   */
  const immersiveSection = (
    key: string,
    heading: string,
    body: ReactNode,
    {
      gap = theme.space[2],
      action,
    }: {
      gap?: number;
      action?: { label: string; accessibilityLabel?: string; onPress: () => void };
    } = {},
  ) => (
    <View key={key} style={styles.immersiveSection} testID={`immersive-section-${key}`}>
      <SectionHeader
        title={heading}
        actionLabel={action?.label}
        actionAccessibilityLabel={action?.accessibilityLabel}
        onPressAction={action?.onPress}
        wrap
        tight
      />
      <View style={{ paddingTop: gap }} testID={`immersive-body-${key}`}>
        {body}
      </View>
    </View>
  );

  /** Spoiler masking for one review, against this viewer and this exact media item. */
  const reviewMasked = (review: TitleReview) =>
    shouldMask({
      hasSpoilers: review.hasSpoilers,
      mediaItemId: title.id,
      viewerId: profile.id,
      authorId: review.userId,
      watched: watched.data,
    });

  /** The reader's own published review, from their own row — a public note, never a private one. */
  const ownPublishedReview = hasReview
    ? {
        text: noteText,
        hasSpoilers: Boolean(data.logged?.note_has_spoilers),
        updatedAt:
          (helpfulReviews.data ?? reviews.data ?? []).find((review) => review.userId === profile.id)
            ?.updatedAt ??
          data.logged?.note_updated_at ??
          null,
        helpfulCount:
          (helpfulReviews.data ?? reviews.data ?? []).find((review) => review.userId === profile.id)
            ?.helpfulCount ?? 0,
      }
    : null;

  /**
   * How many reviews See all leads to. The count and the list are two reads and either
   * can be the fresher one for a moment, so the larger is used: See all is never hidden
   * while a review is on screen.
   */
  const reviewTotal = Math.max(reviewCount.data ?? 0, helpfulReviews.data?.length ?? 0);

  const openReviews = () => {
    setReviewSort(DEFAULT_REVIEW_SORT);
    setReviewsOpen(true);
  };

  const immersiveContent = (
    <>
      <ImmersiveHero
        artwork={hero}
        posterUri={
          posterUri(title.poster_path, 'card') ?? posterUri(parent?.poster_path ?? null, 'card')
        }
        title={displayTitle ?? title.title}
        topInset={insets.top}
        viewportHeight={viewportHeight || undefined}
        onHeight={setImmersiveHeight}
        onModuleTop={setImmersiveModuleTop}
      >
        <View style={styles.immersiveIdentity} testID="title-identity">
          {isSeason && parent?.id ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`${primaryName}, the series this belongs to`}
              onPress={() => router.push(`/title/${parent.id}`)}
              hitSlop={theme.space[1]}
            >
              {immersiveName}
            </Pressable>
          ) : (
            immersiveName
          )}
          <GenreLine genres={descriptive.genres} titleName={displayTitle ?? title.title} />
          {moduleMeta ? (
            <Text testID="title-meta" variant="footnote" tone="secondary" numberOfLines={2}>
              {moduleMeta}
            </Text>
          ) : null}
          {/* Quiet, like the metadata above it, and absent when there is no Director credit
              (title-page sprint, 2026-11-06). Genres stay above it: they decide more. */}
          {directorLine ? (
            <Text
              testID="title-director"
              variant="footnote"
              tone="tertiary"
              numberOfLines={2}
              accessibilityLabel={directorLine.label}
            >
              {directorLine.text}
            </Text>
          ) : null}
          {contextLine ? (
            <Pressable
              accessibilityRole={historyOpen ? 'button' : undefined}
              accessibilityLabel={historyOpen ? 'Watch history' : undefined}
              disabled={!historyOpen}
              hitSlop={8}
              onPress={
                historyOpen ? () => router.push(`/title/${id}/history` as never) : undefined
              }
            >
              <Text testID="title-context" variant="caption" tone="tertiary" numberOfLines={1}>
                {contextLine}
                {historyOpen ? ' ›' : ''}
              </Text>
            </Pressable>
          ) : null}
        </View>

        {immersiveActions}

        {/* Every kind since 2026-11-14. On a show, each number is about the show alone:
            Your score is your explicit show ranking, and bingd and Following average
            other readers' show rankings. A season's rankings never stand in for one. */}
        {rankable ? (
          <ImmersiveScores
            you={
              rankable
                ? {
                    score,
                    pending: Boolean(data.ranked) && score == null,
                    onPress: () => (data.ranked ? setManaging(true) : rank()),
                  }
                : null
            }
            // A count is drawn only once the server has given one: never a 0 while loading.
            bingd={{
              score: community.data?.score ?? null,
              ratingCount: community.data ? community.data.ratingCount : null,
              loading: community.isPending,
            }}
            following={{
              score: following.data?.score ?? null,
              ratingCount: following.data ? following.data.ratingCount : null,
              loading: following.isPending,
            }}
            onPressFollowing={() => setFollowingRatingsOpen(true)}
          />
        ) : null}
      </ImmersiveHero>

      <View style={styles.immersiveNotices}>{notices}</View>

      {/**
       * **The sections, in one column and with no tabs** (title-page sprint, then the final
       * title refinement, 2026-11-06): About, Where to Watch, Episodes or Seasons, Cast,
       * Trailers, Reviews, Similar, and More details last and closed. Discovery before
       * reference: Similar is reachable without scrolling past a list of facts, and the
       * facts are one tap away rather than gone.
       */}
      {title.overview
        ? immersiveSection('about', 'About', <Synopsis text={title.overview} flush />, {
            // Text under text: the two lines' own leading supplies the rest of the gap.
            gap: theme.space[1],
          })
        : null}

      {/* Its spacing travels with it: a title with no providers draws nothing, gap included.
          The row draws its own heading, so the seam is its own top padding, inside its own
          touch area — never a negative margin over the synopsis above it. */}
      <WhereToWatch mediaItemId={title.id} titleName={title.title} topSpace={SECTION_SEAM} />

      {isSeason
        ? immersiveSection('episodes', 'Episodes', tabContent('episodes'))
        : null}
      {isSeries ? immersiveSection('seasons', 'Seasons', tabContent('seasons'), { gap: 0 }) : null}

      {cast.length
        ? immersiveSection(
            'cast',
            'Cast',
            <CastStrip
              compact
              cast={cast.slice(0, CAST_PREVIEW)}
              onPressMember={(member) => router.push(`/person/${member.id}`)}
            />,
            {
              action:
                cast.length > CAST_VISIBLE
                  ? {
                      label: 'See all',
                      accessibilityLabel: `See all ${cast.length} cast members`,
                      onPress: () => setCastOpen(true),
                    }
                  : undefined,
            },
          )
        : null}

      {/**
       * **Trailers, on the page** (title-page sprint, 2026-11-06; before Reviews since the
       * final title refinement). The cards draw at once as video tiles; YouTube stills
       * load whenever `trailerPreviews` is true (the prepared default on this branch).
       * The Show previews action appears only when previews are off (today's live
       * production OTA). A tap on a card opens the video, as it always did.
       */}
      {videos.data?.length && layoutResolved
        ? immersiveSection(
            'trailers',
            'Trailers',
            <TrailerRail
              videos={videos.data}
              label={videoTitle}
              site={(video) => SITE_LABEL[video.site] ?? video.site}
              previews={trailerPreviews}
            />,
            {
              action: trailerPreviews
                ? undefined
                : {
                    label: 'Show previews',
                    accessibilityLabel: 'Show trailer previews. Loads images from YouTube.',
                    onPress: () => setTrailerPreviews(true),
                  },
            },
          )
        : null}

      {/**
       * **Reviews, after Trailers** (post-QA sprint 2, 2026-11-05; moved after Trailers in the
       * final title refinement, 2026-11-06): one or two on the page,
       * yours first, and every review behind See all. Not for a series, which nobody can
       * rank and so nobody can review.
       */}
      {!isSeries
        ? immersiveSection(
            'reviews',
            'Reviews',
            <ReviewsPreview
              reviews={helpfulReviews.data ?? []}
              loading={helpfulReviews.isPending}
              failed={helpfulReviews.isError && !helpfulReviews.data}
              onRetry={() => void helpfulReviews.refetch()}
              maskedFor={reviewMasked}
              viewerId={profile.id}
              viewerRanked={Boolean(data.ranked)}
              ownReview={ownPublishedReview}
              onWrite={() => openLog('review')}
              onSeeAll={openReviews}
              noun={title.kind === 'season' ? 'season' : 'movie'}
              // A person's opinion, not a block of text (UI cohesion pass, 2026-11-06): your
              // own name and picture on your review, and the same thumbs-up the sheet offers
              // under everybody else's. Your score is the module's, so it is not repeated.
              onToggleHelpful={toggleHelpful}
              viewer={{
                name: profile.display_name || profile.username,
                avatarUri: avatarUri(profile.avatar_path),
              }}
            />,
            {
              action:
                reviewTotal > 0
                  ? {
                      label: 'See all',
                      accessibilityLabel:
                        reviewTotal === 1 ? 'See the review' : `See all ${reviewTotal} reviews`,
                      onPress: openReviews,
                    }
                  : undefined,
            },
          )
        : null}

      {/**
       * **Similar, six at first** (final title refinement, 2026-11-06): two rows of three,
       * and See more for the rest of the same list — the same nine `useSimilarTitles`
       * already fetches, so nothing new is asked of the provider.
       */}
      {immersiveSection(
        'similar',
        'Similar',
        tabContent('similar', { similarLimit: similarExpanded ? undefined : SIMILAR_PREVIEW }),
        {
          action:
            similar.tiles.length > SIMILAR_PREVIEW
              ? similarExpanded
                ? {
                    label: 'Show fewer',
                    accessibilityLabel: 'Show fewer similar titles',
                    onPress: () => setSimilarExpanded(false),
                  }
                : {
                    label: 'See more',
                    accessibilityLabel: `See ${similar.tiles.length - SIMILAR_PREVIEW} more similar titles`,
                    onPress: () => setSimilarExpanded(true),
                  }
              : undefined,
        },
      )}

      {moreDetails.length ? (
        <View style={styles.immersiveSection} testID="immersive-section-details">
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="More details"
            accessibilityState={{ expanded: detailsOpen }}
            onPress={() => setDetailsOpen((open) => !open)}
            style={({ pressed }) => [styles.moreDetailsToggle, pressed && styles.pressed]}
            testID="more-details-toggle"
          >
            <Text variant="sectionHeader" tone="action">
              MORE DETAILS
            </Text>
            <Ionicons
              name={detailsOpen ? 'chevron-up' : 'chevron-down'}
              size={theme.layout.icon.sm}
              color={theme.semantic.action}
            />
          </Pressable>
          {detailsOpen ? (
            <View style={styles.facts} testID="more-details">
              {moreDetails.map(([label, value]) => (
                <View key={label} style={styles.fact} accessible accessibilityLabel={`${label}: ${value}`}>
                  <Text variant="footnote" tone="tertiary" style={styles.factLabel}>
                    {label}
                  </Text>
                  <Text variant="footnote" style={styles.factValue}>
                    {value}
                  </Text>
                </View>
              ))}
            </View>
          ) : null}
        </View>
      ) : null}

      {castOpen ? (
        <Sheet visible onClose={() => setCastOpen(false)} label={`Cast of ${title.title}`}>
          <View style={styles.castSheet} testID="cast-sheet">
            <Text variant="title2">Cast</Text>
          </View>
          {/* Bounded and scrolling: twelve rows at a large text size are taller than the
              sheet, and the last members must still be reachable. */}
          <ScrollView
            testID="cast-sheet-list"
            style={styles.castScroll}
            contentContainerStyle={styles.castList}
          >
            {cast.map((member) => (
              <Pressable
                key={member.id}
                accessibilityRole="button"
                accessibilityLabel={
                  member.character ? `${member.name}, who plays ${member.character}` : member.name
                }
                onPress={() => {
                  setCastOpen(false);
                  router.push(`/person/${member.id}`);
                }}
                style={({ pressed }) => [styles.castRow, pressed && styles.pressed]}
              >
                <Avatar size="sm" uri={member.avatarUri} name={member.name} />
                <View style={styles.immersiveCircleCopy}>
                  <Text variant="callout" numberOfLines={1}>
                    {member.name}
                  </Text>
                  {member.character ? (
                    <Text variant="caption" tone="tertiary" numberOfLines={1}>
                      {member.character}
                    </Text>
                  ) : null}
                </View>
              </Pressable>
            ))}
          </ScrollView>
          <SheetDone onPress={() => setCastOpen(false)} />
        </Sheet>
      ) : null}

      <Sheet
        visible={reviewsOpen}
        onClose={() => setReviewsOpen(false)}
        label={`Reviews of ${displayTitle ?? title.title}`}
        onDismissed={() => {
          if (!pendingReviewWrite.current) return;
          pendingReviewWrite.current = false;
          openLog('review');
        }}
      >
        <View style={styles.castSheet} testID="reviews-sheet">
          <Text variant="title2">
            {reviewTotal ? `Reviews (${reviewTotal})` : 'Reviews'}
          </Text>
        </View>
        <ScrollView
          testID="reviews-sheet-list"
          style={styles.castScroll}
          contentContainerStyle={styles.reviewsSheetList}
        >
          {reviewList({ inSheet: true })}
        </ScrollView>
        <SheetDone onPress={() => setReviewsOpen(false)} />
      </Sheet>
    </>
  );

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
      {/* Dark glyphs over the Parchment band a title without artwork gets, from the first
          frame; light over artwork until the bar has revealed. */}
      {immersive && focused ? (
        <StatusBar style={barRevealed || !hero.uri ? 'dark' : 'light'} />
      ) : null}

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
        /**
         * The menu, where the Ranked control used to keep it.
         *
         * **It is now on every title** (lists-prd.md §P.4, 2026-09-19). It used to be
         * present only where there was something to manage — a ranked title, and since
         * 2026-09-18 a film or season that is logged but unranked, so that a wrongly
         * imported film could be taken out without being ranked first. `Add to list…`
         * applies to **every movie, season and whole series**, ranked or not, logged or
         * not, which is the one thing that could be true of a title with nothing else in
         * its menu — including a series, which has never had one.
         *
         * Nothing below it changed: the ranking rows and Remove from collection keep
         * their place and their conditions, and a title with neither simply gets a menu
         * whose only row is the list one. No hero control, no fourth `TitleActions`
         * button, no permanent list button anywhere (§D).
         */
        // Only when the menu has something in it: Add to list moved to the action row,
        // so a title that is neither ranked nor logged has no menu rows left.
        onMore={data.ranked || data.logged ? () => setManaging(true) : undefined}
        title={displayTitle ?? title.title}
        subtitle={parent?.title ?? null}
      />

      <Animated.ScrollView
        ref={pageScroller}
        testID="title-scroll"
        onLayout={(event: LayoutChangeEvent) => {
          const next = Math.round(event.nativeEvent.layout.height);
          setViewportHeight((was) => (was === next ? was : next));
        }}
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
            {...pull}
            // Below the transparent bar, so the spinner is not drawn under the back
            // control on a screen whose content starts at the top of the display.
            progressViewOffset={insets.top + NAV_BAR_HEIGHT}
            tintColor={theme.semantic.action}
            colors={[theme.semantic.action]}
          />
        }
      >
        {/* Original and Immersive share everything outside this scroll view. The original
            children below keep their lines exactly as they were; only this wrapper is new. */}
        {immersive ? (
          immersiveContent
        ) : (
          <>
        <View>
          <TitleHero
            uri={hero.uri}
            blurred={hero.treatment === 'poster'}
            collapsedHeight={collapsedHero}
            topInset={insets.top}
          />
          {/* Nothing is drawn on the artwork. The recommendation used to sit here as a
              pill at the hero's lower edge; it is a card below the title now, for every
              title (founder F1, 2026-09-19) — see `RecommendationCard`. */}
        </View>

        {/**
         * **Identity left, poster right, actions inside the left column, and every word
         * of it on Paper** (founder, final direction, 2026-09-07).
         *
         * ---------------------------------------------------------------------------
         * WHY THE WORDS ARE NOT ON THE ARTWORK
         *
         * The first pass of this redesign put the poster on the left and the words on the
         * right, with the whole row pulled up into the artwork. The founder's correction:
         * **primary title text must not depend on being readable over a backdrop nobody
         * chose.** A hero is unpredictable — a night scene, a white sky, a face — and a
         * serif title set on it is legible on the artwork the designer happened to be
         * looking at.
         *
         * So the row starts at the hero's lower edge and everything in it sets on the
         * page's own Paper — **including the poster**, since 2026-09-08. It used to be
         * pulled up across the fade on the argument that artwork may cross a line the
         * words may not, and on the device that made it a member of the hero rather than
         * of this block: level with the middle of the title instead of with its first
         * line. Nothing crosses the fade now. See `TITLE_CAP_OFFSET`.
         *
         * ---------------------------------------------------------------------------
         * THE ROW IS A PLAIN FLEX ROW, AND THAT IS WHAT KEEPS THE SYNOPSIS CLEAR
         *
         * `flexDirection: 'row'` with `alignItems: 'flex-start'`, no height, no minimum,
         * nothing absolutely positioned and no negative margin anywhere inside it. So the
         * row's height is exactly the taller of its two children, and the synopsis — the
         * next sibling — begins below **both** the poster and the left stack without
         * anything having to compute which of them won. A one-line film with no credit
         * clears the poster's 154; a wrapped two-line season title with five metadata
         * lines and the action row clears the left stack instead.
         *
         * ---------------------------------------------------------------------------
         * THE ACTIONS ARE IN THIS COLUMN, AND THE ROW HAS NO FIXED HEIGHT
         *
         * They were a full-width row *after* the whole identity region, which meant they
         * waited for the bottom of a 150pt poster before they could be drawn. On a short
         * title — a one-line name, a year, a length, no credit — that left an obvious
         * empty band beside the poster and pushed the page's primary control down past
         * it. The design draft's answer was to pin the row to 150pt so the button always
         * landed at the same y; the founder rejected that as the same dead space made
         * deliberate.
         *
         * The row is content-driven instead. The stack is title, subtitle, metadata,
         * personal context, actions — all inside the column beside the poster — so the
         * button rises on a short title and sits lower on a long one, and the space
         * beside the poster is used rather than reserved. Identical action-row
         * coordinates across the catalogue were never the goal; a consistent rhythm was.
         *
         * The synopsis still begins full width, below whichever of the two columns is
         * taller.
         *
         * ---------------------------------------------------------------------------
         * THE POSTER CARRIES ARTWORK AND NOTHING ELSE
         *
         * No score, no `Your score` caption, no dashed ring, no rank badge. The reader's
         * own number is the first unit of the Scores section now (`ScoresSection`), where
         * it has the two things it never had on the poster: a label saying whose it is,
         * and something to be compared against. What sat here was a badge overhanging a
         * corner with a caption under it, and every revision of it fought the artwork it
         * was pinned to.
         */}
        <View style={styles.identity} testID="title-identity">
          <View style={styles.identityCopy} testID="title-identity-copy">
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
                <Text testID="title-name" variant="title1" numberOfLines={TITLE_LINES}>
                  {primaryName}
                </Text>
              </Pressable>
            ) : (
              <Text testID="title-name" variant="title1" numberOfLines={TITLE_LINES}>
                {primaryName}
              </Text>
            )}
            {identitySubtitle ? (
              <Text
                testID="title-subtitle"
                variant="callout"
                tone="secondary"
                // Every line of the identity block is one line. A season name long
                // enough to wrap turns the subtitle into a paragraph under the heading.
                numberOfLines={1}
              >
                {identitySubtitle}
              </Text>
            ) : null}
            {/* Built before it is rendered, because all three parts can be missing at
                once — an obscure title with no certification, no length and no credit —
                and an empty `Text` is not nothing on screen. It is a line box with the
                footnote's height, which reads as a gap under the title. Review 17e. */}
            {metaLine ? (
              <Text
                testID="title-meta"
                variant="footnote"
                tone="secondary"
                // One line, always. A creative credit long enough to wrap turns a
                // three-part metadata line into a two-line paragraph, which is the
                // founder's "prefer truncation over wrapping the metadata".
                numberOfLines={1}
              >
                {metaLine}
              </Text>
            ) : null}
            {/**
             * **The slot is always here, even before there is anything to put in it**
             * (founder, physical QA, 2026-09-08).
             *
             * This line is the only part of the identity column that appears *because* of
             * ranking: before, there is no placement and no watch date, so it rendered
             * nothing; after, `Watched 8 Sep 2026` arrives and pushed the actions row, the
             * synopsis and the whole page down by one caption line. The successful
             * Rank → Ranked transition ended in a jump, which read as the page correcting
             * itself rather than as the thing the reader just did having worked.
             *
             * Reserved rather than measured. A `minHeight` in points would be a lie the
             * moment somebody raises their system text size — the line grows and the
             * reservation does not — so the element that holds the space is the same
             * `Text`, in the same variant, carrying a zero-width space when it has nothing
             * to say. It scales because it is real text, and it shows nothing because the
             * character has no glyph. **Not** a placeholder word: the founder ruled out
             * `Not watched yet` and `—`, and they were right — an empty line is not a fact
             * about the title and should not read as one.
             *
             * Hidden from accessibility while empty, so a screen reader is not handed a
             * blank line to announce between the metadata and the actions.
             */}
            {/**
             * Tappable whenever there is a history to open (§J.2). A `Pressable` around
             * the existing `Text` rather than a new row: the reservation that holds this
             * line's height is the `Text` itself carrying a zero-width space, and
             * replacing it would reintroduce the layout jump that reservation exists to
             * prevent.
             */}
            <Pressable
              accessibilityRole={historyOpen ? 'button' : undefined}
              accessibilityLabel={historyOpen ? 'Watch history' : undefined}
              disabled={!historyOpen}
              hitSlop={8}
              onPress={
                historyOpen ? () => router.push(`/title/${id}/history` as never) : undefined
              }
            >
              <Text
                testID="title-context"
                variant="caption"
                tone="tertiary"
                numberOfLines={1}
                style={styles.contextLine}
                accessibilityElementsHidden={!contextLine}
                importantForAccessibility={contextLine ? 'auto' : 'no-hide-descendants'}
              >
                {contextLine || ZERO_WIDTH}
                {historyOpen && contextLine ? ' ›' : ''}
              </Text>
            </Pressable>

            {/**
             * **Rank/Ranked, Save, Recommend — inside this column, directly under the
             * personal-context line** (founder, 2026-09-07).
             *
             * Not after the whole identity region, which is where it was: there it had to
             * wait for the bottom of the poster, so on a short title an empty band opened
             * up beside the artwork and the page's primary control sat below it. Here it
             * rises with the copy above it and fills the column the poster leaves.
             *
             * The Rank/Ranked control keeps its **text and its behaviour**: unranked opens
             * the log, ranked opens the ranking-options menu. Nothing here decides between
             * ranking the same watch again and logging another watch, because that is the
             * menu's job and the distinction is the whole point of it.
             */}
            {actionsBesidePoster ? <View style={styles.actionsRow}>{actions}</View> : null}
          </View>

          <View style={styles.posterColumn} testID="title-poster-column">
            <View style={styles.posterFrame}>
              <Poster
                /**
                 * The season's own artwork, then the series'.
                 *
                 * A season with no poster of its own is a real state in this catalogue,
                 * and before this it fell straight through to the branded placeholder
                 * while the series' perfectly good key art sat one row away — the same
                 * inheritance `heroArtwork` already does for the backdrop. The placeholder
                 * is still the answer when neither exists; it is never a stretched or
                 * letterboxed stand-in.
                 */
                uri={
                  posterUri(title.poster_path, 'card') ??
                  posterUri(parent?.poster_path ?? null, 'card')
                }
                title={displayTitle ?? title.title}
                // `detail` — 100×150. `md` was 88 wide, which read as a thumbnail left
                // beside the title rather than as the counterweight to it; `lg` at 132
                // left too little width to set a serif title in.
                size="detail"
              />
            </View>
          </View>
        </View>

        {actionsBesidePoster ? null : (
          <View style={styles.actionsFullWidth} testID="title-actions-full-width">
            {actions}
          </View>
        )}

        {/* Who recommended this, and what they said — below the title and its actions,
            in the flow, whether or not there is artwork (founder F1, 2026-09-19). It sits
            beside Rank, Save and Recommend because those are what a note is asking for,
            and it is off the hero because a note is somebody's words and must not depend
            on being readable over a backdrop. Present however the reader arrived; gone
            once they rank the title. */}
        {notices}

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
         * A whole show has its own row since 2026-11-14: its own explicit rankings, never
         * an average of its seasons'.
         *
         * **The reader's own score leads this row** (founder, 2026-09-07). It was on the
         * poster and is not any more; the poster carries artwork and nothing else. Three
         * units, in one fixed order — `Your score`, `Following`, `bingd.` — which is a
         * hierarchy of relevance to one reader rather than a leaderboard: me, then the
         * people I chose, then the room. The number is stated once on this page, here.
         */}
        {rankable ? (
          <ScoresSection
            you={
              rankable
                ? {
                    score,
                    // Ranked, but the band sizes that derive the number have not landed
                    // yet. `Score loading` rather than `Not ranked yet`, which would
                    // contradict the Ranked control a few points above it.
                    pending: Boolean(data.ranked) && score == null,
                    // Exactly where the Ranked control leads: a ranked title opens its
                    // options, an unranked one opens the log. The score has been a place
                    // to press to change a rating since 2026-09-06 and still is.
                    onPress: () => (data.ranked ? setManaging(true) : rank()),
                  }
                : null
            }
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
            a series.

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
            onChange={(next) => {
              // A deliberate move *to* Similar, and nothing else. Compared against
              // `activeTab` rather than `tab`: on a film Similar is the default, so `tab`
              // is still null while it is on screen, and pressing the tab you are already
              // looking at must not count as opening it. The film's arrival on Similar is
              // therefore not an event either — that is a page view, which the page
              // already has — so this counts readers who chose it.
              if (next === 'similar' && activeTab !== 'similar') {
                track({
                  name: 'similar_tab_opened',
                  props: { medium: title.kind === 'movie' ? 'movies' : 'tv' },
                });
              }
              setTab(next);
            }}
          />
        </View>

        {/* Episodes. Informational only: a card opens the episode's details and
            nothing is scoreable or loggable, because the rankable unit is the season
            this page already is (PRD §10). What the rail answers is "did I watch this one". */}
        {tabContent(activeTab)}

          </>
        )}

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
          setPendingShowLink(null);
          celebrate();
        }}
        onClose={() => {
          setLoggingTitle(null);
          setPlacement(null);
          setActionError(null);
          // Leaving the show's band chooser without choosing abandons Update Show.
          setPendingShowLink(null);
          celebrate();
        }}
        onRank={(bucket, mode, context) => {
          if (!loggingTitle) return;
          // Update Show's link, only on the show it was offered for and only on the
          // correction calls (a show that lost its ranking meanwhile is a first ranking,
          // which the server would refuse to link).
          const linked =
            pendingShowLink?.showId === loggingTitle.id && mode !== 'start'
              ? pendingShowLink.linkedPlacementId
              : null;
          setPendingShowLink(null);
          setRankingSubject({
            id: loggingTitle.id,
            title: loggingTitle.title,
            bucket,
            posterUri: loggingTitle.posterUri,
            kind: loggingTitle.kind,
            mode,
            freshLog: context?.freshLog ?? false,
            linkedPlacementId: linked,
          });
          setRankedTitle(loggingTitle);
          setPlacement(null);
          setLoggingTitle(null);
        }}
      />
      {/**
       * *Log another watch* (§J.3). Mounted beside `RankingSheet` rather than inside it,
       * and it is **fully dismissed before the ranking sheet is presented** — two
       * presented sheets at once is the iOS dead end this codebase has paid for before,
       * and so is a presentation issued while a dismissal is still animating.
       *
       * Hence `rewatchPhase` rather than a boolean, and `openRecheck` being called from
       * `onDismissed` on iOS: the component stays mounted and invisible for the length
       * of the slide-out so that callback can arrive at all. Android has no presentation
       * to serialise against (`Sheet`'s contract) and goes straight across.
       */}
      {rewatchPhase !== 'closed' ? (
        <LogAnotherWatchSheet
          open={rewatchPhase === 'open'}
          title={displayTitle ?? title.title}
          mediaItemId={title.id}
          posterUri={posterUri(title.poster_path, 'card') ?? posterUri(parent?.poster_path ?? null, 'card')}
          subtitle={year ? String(year) : null}
          onClose={() => {
            pendingRecheck.current = null;
            setRewatchPhase('closed');
          }}
          onSaved={() => {
            invalidateAfterCollectionChange(queryClient, profile.id, title.id, {
              category: data.ranked?.category,
            });
          }}
          onRank={(watchEventId, bucket) => {
            pendingRecheck.current = { watchEventId, bucket };
            if (Platform.OS === 'ios') {
              setRewatchPhase('leaving');
            } else {
              setRewatchPhase('closed');
              openRecheck();
            }
          }}
          onDismissed={() => {
            if (rewatchPhase !== 'leaving') return;
            setRewatchPhase('closed');
            openRecheck();
          }}
        />
      ) : null}
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
        onUpdateShow={updateShow}
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
      {/* Mounted while it is open **and** while it is dismissing on its way to another
          sheet: an unmounted `Modal` sends no `onDismiss`, and the hand-off below waits
          for exactly that. `visible` carries open-or-closed instead. */}
      {managing || menuLeaving ? (
        <Sheet
          visible={managing}
          onClose={() => setManaging(false)}
          label={`Options for ${displayTitle ?? title.title}`}
          /**
           * The serialised handover to the Add-to-list sheet, on iOS only.
           *
           * UIKit refuses a presentation issued while it is still dismissing another
           * from the same presenter, React believes it succeeded, and what is left is a
           * transparent window that swallows every touch — the reproduced 2026-09-10
           * freeze (`Sheet.onDismissed`). This menu is on the audit's own list of
           * unserialised swaps, and both rows that leave it for another sheet are new —
           * `Add to list…` (Lists §P.4) and *Log another watch* (§J.3) — so both wait.
           *
           * **Do not "simplify" this back into a pair of `setState` calls.** That is
           * exactly the shape of the bug, and the screen renders perfectly while it has
           * stopped accepting touches.
           */
          onDismissed={() => {
            const to = menuHandoff.current;
            menuHandoff.current = null;
            setMenuLeaving(false);
            if (to === 'list') setAddingToList(true);
            if (to === 'rewatch') setRewatchPhase('open');
          }}
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
             *
             * **A logged title that is not ranked gets the last group only** (Android beta
             * report, 2026-09-18). A Letterboxd import had put the wrong film on somebody's
             * shelf, logged and unranked, and this sheet — the only door to Remove — opened
             * only for a ranked title, so the way out was to rank a film they had not seen.
             * Anything in the collection can now leave it without being ranked first.
             * `removeFromCollection` already skips `rank_unrank` when there is no ranking,
             * and `unlog` has always accepted an unranked title.
             *
             * The two upper groups stay ranked-only: both rows under Ranking act on a
             * position, and for an unranked title the Rank control is already the door to
             * the log. This adds a way out, not a second way in.
             */}
            {data.ranked ? (
              <>
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
                 * **Two rows, because there were only ever two acts** (founder, physical QA,
                 * 2026-09-08).
                 *
                 * ---------------------------------------------------------------------------
                 * WHAT WAS HERE, AND WHY THREE WAS ONE TOO MANY
                 *
                 * The menu offered *Rank it again*, *Log another watch* and *Change your
                 * rating*. The middle one is a real, separate act — a second viewing — and the
                 * outer two were **two doors into the same correction**, named so similarly
                 * that no ordinary reader could say which one they wanted. "Rank it again"
                 * and "Change your rating" describe the same intent in two vocabularies; the
                 * only difference was mechanical, and mechanical differences are exactly what
                 * the 2026-09-07 pass had already decided this menu must stop exposing.
                 *
                 * (That pass is worth keeping in the record: the founder ranked a season,
                 * adjusted it a minute later, and saw two "ranked" rows in the feed for one
                 * watch. Nothing was broken underneath — `_rank_finalize` has posted
                 * `title_ranked` only `if p_new_watch or not v_replaced` since
                 * 20260826000500 — the row named *Rank again* simply meant "another viewing"
                 * and read like "redo my ranking". Renaming it to *Rank it again* fixed the
                 * misfire and left two correction rows behind. This removes one.)
                 *
                 * ---------------------------------------------------------------------------
                 * THE CONSOLIDATION IS AN ENTRY POINT, NOT A CAPABILITY
                 *
                 * **`Edit ranking` is the single same-watch correction path, and it can
                 * do everything both rows could.** It opens `LogSheet`'s bucket chooser, which
                 * has had three branches since 2026-08-15 and keeps all of them:
                 *
                 *   a *different* band   → `rank_rebucket`. The band moves and the comparisons
                 *                          are re-run, because a band change cannot be
                 *                          estimated (PRD §10).
                 *   the *same* band      → `rankAgain(newWatch: false)` — which is precisely
                 *                          what *Rank it again* called. Re-opening a rating you
                 *                          already gave means the *position* is wrong, and this
                 *                          is how a reader says so.
                 *   neither, then close  → nothing at all. Since 20260826000500 the session
                 *                          runs over the position the title holds, so opening
                 *                          this and changing your mind costs nothing.
                 *
                 * So placement can still be corrected for the same watch, and nobody is made
                 * to log a viewing they did not have in order to do it. The one extra tap is
                 * the band chooser, which is also the screen that tells the reader which of
                 * the two things they meant.
                 *
                 * ---------------------------------------------------------------------------
                 * THE SEMANTICS ARE UNTOUCHED
                 *
                 *   Edit ranking         corrects the current watch. `p_new_watch` false, no
                 *                        new watch record, no timestamp heuristic anywhere.
                 *                        No feed activity for a film; for a show or season
                 *                        (20261114000300), one "updated their ranking of"
                 *                        post only when the correction moved it.
                 *   Log another watch    an explicit second viewing. `p_new_watch` true, and
                 *                        exactly one `title_ranked` on completion.
                 *
                 * No RPC, argument, migration or piece of ranking maths changes in this pass,
                 * and no historical activity is rewritten or de-duplicated. `rerank` still
                 * exists and is still reached; it is reached through one row instead of two.
                 *
                 * The labels carry the whole distinction and there is no secondary line: a
                 * `value` on a `SheetRow` sets beside the label and truncates at phone width,
                 * which is a founder decision this menu already carries.
                 */}
                {/* The star is kept from the row this replaces, and so is its behaviour:
                    straight into the log sheet, where the band chooser is. Leads the group
                    because correcting a rating is the common act and logging a second
                    viewing is the rare one. */}
                <SheetRow
                  icon="star-outline"
                  label="Edit ranking"
                  onPress={() => {
                    setManaging(false);
                    openLog();
                  }}
                />
                {/**
                 * The explicit rewatch, and the only row in the app that declares one.
                 *
                 * ---------------------------------------------------------------------------
                 * **IT RECORDS A WATCH NOW, AND THAT IS THE WHOLE CHANGE** (§J.3, T3b)
                 *
                 * It used to open the ranking sheet directly in `mode: 'again'`: a forced
                 * full re-rank that recorded **no watch and no date** (§C.3.2). A reader
                 * saying "I watched Heat again last night" was made to answer six
                 * comparisons, and at the end of it the app knew nothing about the viewing.
                 *
                 * Now it opens a sheet whose first act is the watch — Today in one tap,
                 * *Earlier* if they do not remember when — and which offers the re-check
                 * afterwards. Save and close, and the rewatch is recorded and posted; tap
                 * *Re-check placement*, and `rank_again` runs over the position the title
                 * already holds with the new §F.2 policy, which costs about two comparisons
                 * when nothing has changed.
                 *
                 * **One viewing still produces exactly one feed activity**, which is what
                 * the label has always promised. The sheet posts it; the re-check enriches
                 * that same post with the new score rather than writing a second one (§K).
                 * Two genuine rewatches are still two activities; that is not a duplicate.
                 */}
                <SheetRow
                  icon="repeat-outline"
                  label="Log another watch"
                  onPress={
                    rankedBucket
                      ? () => {
                          setActionError(null);
                          // Serialised the same way `Add to list…` is: this row leaves
                          // the menu for another modal, and on iOS the presentation
                          // waits for this one's dismissal to finish.
                          if (Platform.OS === 'ios') {
                            menuHandoff.current = 'rewatch';
                            setMenuLeaving(true);
                            setManaging(false);
                          } else {
                            setManaging(false);
                            setRewatchPhase('open');
                          }
                        }
                      : undefined
                  }
                  disabledReason={rankedBucket ? undefined : 'Loading'}
                />
              </>
            ) : null}

            {/**
             * **Gated on the title actually being in the collection**, which it was
             * not obliged to be until this menu opened on every title (§P.4).
             *
             * It used to be unconditional, and that was correct while `onMore` itself
             * carried the condition — the sheet could not open for a title that was
             * neither ranked nor logged. Now that it can, an ungated Remove would offer
             * to take a film off a shelf it has never been on, and the confirmation
             * would be the first place anybody found out.
             */}
            {data.ranked || data.logged ? (
              <>
                <MenuGroup title="Collection" />
                <SheetRow
                  icon="trash-outline"
                  label="Remove from collection"
                  onPress={confirmRemoval}
                />
              </>
            ) : null}
          </View>
        </Sheet>
      ) : null}

      {/* `Title ⋯ → Add to list…`. Mounted only while open, like every sheet on this
          screen: it reads the caller's lists on mount, which is exactly the read not to
          keep warm on a title page nobody is listing. */}
      {addingToList ? (
        <AddToListSheet
          mediaItemId={title.id}
          kind={title.kind}
          name={displayTitle ?? title.title}
          profilePrivate={profile.visibility === 'private'}
          onClose={() => setAddingToList(false)}
          onOpenList={(listId) => router.push(`/lists/${listId}?surface=title_menu`)}
        />
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
      {/* Everybody who recommended this, from the card (20260929000100). Kept mounted,
          invisible, while it hands over to a report, so iOS has finished dismissing it
          before the report sheet presents — `Sheet`'s `onDismissed` contract. Android has
          no presentation to wait for and fires no dismissal, so it goes straight across. */}
      {recSheet?.kind === 'all' || recSheet?.kind === 'handoff' ? (
        <RecommendersSheet
          visible={recSheet.kind === 'all'}
          rows={recommendationRows}
          onClose={() => setRecSheet(null)}
          onDismissed={() =>
            setRecSheet((current) =>
              current?.kind === 'handoff' ? { kind: 'report', id: current.id } : current,
            )
          }
          onOpenProfile={(username) => {
            // Close first, for the reason FollowingRatingsSheet gives above.
            setRecSheet(null);
            router.push(`/u/${username}`);
          }}
          onReport={(recommendationId) =>
            setRecSheet(
              Platform.OS === 'ios'
                ? { kind: 'handoff', id: recommendationId }
                : { kind: 'report', id: recommendationId },
            )
          }
        />
      ) : null}
      {recSheet?.kind === 'report' ? (
        <ReportSheet
          visible
          onClose={() => setRecSheet(null)}
          subject="recommendation"
          subjectId={recSheet.id}
          noun="note"
        />
      ) : null}
    </Screen>
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
 * The embedded parent series, however PostgREST shaped it.
 *
 * A `parent:parent_id(...)` embed is a single object at runtime, and the generated
 * types model the same relationship as a one-element array in some builds — so both
 * shapes have to be read. It was written out inline where the identity block needs it
 * and is a function now because the Similar tab needs the same id several hundred lines
 * earlier, before `title` is narrowed.
 */
function parentOf<T>(embedded: T | T[] | null | undefined): T | null {
  if (!embedded) return null;
  return (Array.isArray(embedded) ? (embedded[0] ?? null) : embedded) as T | null;
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
 * **The poster does not rise into the hero any more** (founder, physical Android,
 * 2026-09-08).
 *
 * There was a lift, and it was 64, then 120, then 88, then 56. The founder's reading on
 * the device is the one that ends the sequence: whatever the number, a poster pulled up
 * across the hero's fade **belongs to the hero**, and it therefore reads as detached from
 * the title sitting level with its middle. No lift is small enough to fix that, because
 * the defect is which block the artwork is a member of rather than how far it travels.
 *
 * The poster is part of the identity block now. Its top edge is optically aligned with the
 * first line of the title, and {@link TITLE_CAP_OFFSET} is the whole of the adjustment.
 *
 * Two things that used to depend on the lift are now stated on their own terms, below:
 * the collapsed band's height, and where the recommendation callout sits.
 */
// HERO_COLLAPSED_BAND and REVEAL_WINDOW live in use-hero-reveal, shared with the list page.

/**
 * How far the poster sits below the top of the identity row, so its top rule meets the
 * title's **cap height** rather than its line box.
 *
 * `title1` is 28pt of DM Serif on a 34pt line, so the line box carries about six points of
 * leading and roughly half of that sits above the capitals. Aligned to the box, the poster
 * measures level with the title's *ascent* and reads as sitting a few points high; aligned
 * to the caps, the two objects start on the same line the way a reader sees it.
 *
 * Four points rather than a measurement, because the leading is a property of the type
 * token and not of the string: it is the same on every title in the catalogue.
 */
/** A stable empty list, so "nobody recommended this" is the same value every render. */
const NO_RECOMMENDATIONS: TitleRecommendation[] = [];

const TITLE_CAP_OFFSET = theme.space[1];

const styles = StyleSheet.create({
  content: { paddingBottom: theme.space[10] },
  // ---- Immersive Scroll experiment (2026-11-04)
  immersiveIdentity: { gap: theme.space[1] },
  immersiveNotices: {},
  /**
   * The seam between two sections (final title refinement, 2026-11-06): 20pt from the end
   * of one body to the next heading, inside the founder's 20–24.
   */
  immersiveSection: { paddingTop: SECTION_SEAM },
  /** More details: a heading-sized disclosure with a 44pt target, its facts beneath. */
  moreDetailsToggle: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: theme.space[1],
    minHeight: theme.layout.minTapTarget,
    marginTop: -(theme.layout.minTapTarget - 16) / 2,
    marginBottom: -(theme.layout.minTapTarget - 16) / 2,
    paddingHorizontal: theme.layout.gutter,
  },
  facts: {
    paddingHorizontal: theme.layout.gutter,
    paddingTop: theme.space[2],
    gap: theme.space[2],
  },
  fact: { flexDirection: 'row', flexWrap: 'wrap', columnGap: theme.space[3] },
  factLabel: { flexBasis: '36%', flexGrow: 0, flexShrink: 0 },
  factValue: { flexBasis: '50%', flexGrow: 1, flexShrink: 1 },
  // One quiet line above the tabs, on Paper: no card of its own.

  immersiveCircleCopy: { flex: 1, gap: 2 },
  castSheet: { paddingHorizontal: theme.layout.gutter, paddingBottom: theme.space[2] },
  reviewsSheetList: { paddingBottom: theme.space[2] },
  castScroll: { maxHeight: Math.round(Dimensions.get('window').height * 0.6) },
  castList: { gap: theme.space[2], paddingHorizontal: theme.layout.gutter },
  castRow: { flexDirection: 'row', alignItems: 'center', gap: theme.space[3], minHeight: theme.layout.minTapTarget },
  /**
   * **The row starts where the hero ends** (founder, final direction, 2026-09-07).
   *
   * No negative margin on the row itself, which is the whole of "the title must not rely
   * on being readable over the backdrop": every word in the left column sets on Paper.
   * The poster is lifted on its own, below, because artwork over artwork is fine and text
   * over artwork is a gamble on which backdrop the reader happened to open.
   *
   * `flex-start`, not `flex-end`: the title and the top of the poster begin on the same
   * line, so a one-line film title and a wrapped three-line one both start level with the
   * artwork rather than the block sliding up and down with the length of a name.
   */
  identity: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: theme.space[4],
    paddingHorizontal: theme.layout.gutter,
    paddingTop: theme.space[3],
  },
  /**
   * The poster, as one object on the right.
   *
   * The lift lives here rather than on the row, so the artwork crosses the hero's fade
   * and the words do not. It carries nothing but the artwork now — the score that used to
   * be anchored to its corner is the first unit of the Scores section.
   */
  /**
   * The poster, level with the title's first line.
   *
   * A positive offset, and a small one. It used to be `-POSTER_LIFT`, which pulled the
   * frame up across the hero's fade — see the note on {@link TITLE_CAP_OFFSET} for why
   * that had to go rather than shrink. Nothing here is absolutely positioned and the
   * column has no containing block, so the poster cannot overlay anything and the row's
   * height is simply the taller of its two children.
   */
  posterColumn: { marginTop: TITLE_CAP_OFFSET },
  /**
   * Everything that names the title *and everything you can do to it*, on the left.
   *
   * `flex: 1` so it takes the width the poster leaves and a long name wraps inside it
   * rather than pushing the row wider than the gutters allow. `minWidth: 0` because a
   * flex child's default minimum is its content, and without it a long unbroken title
   * pushes the poster off the right gutter instead of wrapping.
   *
   * The `gap` is the founder's 4–6 for the metadata stack. Two children take more than
   * that and add their own margin on top of it: see `contextLine` and `actionsRow`.
   */
  identityCopy: { flex: 1, minWidth: 0, gap: theme.space[1] },
  /**
   * `space[1]` on top of the column's own `space[1]` gap, so the personal context sits 8
   * below the metadata.
   *
   * The founder's contract asks for 6–8 here, and the reason it is more than the 4 above
   * it is that this line is a different kind of fact: everything above it is about the
   * title and this is about the reader.
   */
  contextLine: { marginTop: theme.space[1] },
  /**
   * `space[2]` on top of the column's `space[1]` gap: 12 from the line above.
   *
   * The founder's contract asks for 12–16 between the personal context and the actions,
   * and this is the interval that stops the row reading as glued to the text. It is set
   * here rather than inside `TitleActions` because the distance is one term in a spacing
   * contract this screen holds, not a property of a button cluster.
   */
  actionsRow: { marginTop: theme.space[2] },
  // The same 12 from whatever is above it, now the taller of the two columns.
  actionsFullWidth: {
    paddingHorizontal: theme.layout.gutter,
    paddingTop: theme.space[3],
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
    // The page's section interval, the same one the Scores block and Where to watch
    // open with, plus the rule.
    marginTop: theme.space[7],
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
  // The original page's tab row has no gap under it; the rail draws no vertical padding.
  episodesTab: { paddingTop: theme.space[3], paddingBottom: theme.space[2] },
  pressed: { opacity: 0.7 },
});
