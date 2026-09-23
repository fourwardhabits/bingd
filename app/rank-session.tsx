import { useLocalSearchParams, useRouter } from 'expo-router';

import { RankSessionScreen } from '@/features/ranking/RankSessionScreen';

/**
 * The one ranking session (unified Backlog + Refine, 2026-09-21), opened as
 * `/rank-session?medium=movies|tv_seasons&start=backlog|refine`.
 *
 * Pushed from Collection: the Unranked tab's **Start ranking** (backlog) and the Watched
 * card's **Refine rankings** (refine). Both cards are drawn only while the server says the
 * feature is on, so this route is unreachable with the flags off; opened by hand anyway, it
 * asks the server and says *Not available* / *You're caught up*.
 *
 * Both params are validated rather than trusted: an unknown medium opens Movies and an
 * unknown start opens the backlog.
 */
export default function RankSessionRoute() {
  const router = useRouter();
  const { medium, start } = useLocalSearchParams<{ medium?: string; start?: string }>();
  return (
    <RankSessionScreen
      medium={medium === 'tv_seasons' ? 'tv_seasons' : 'movies'}
      start={start === 'refine' ? 'refine' : 'backlog'}
      onExit={() => (router.canGoBack() ? router.back() : router.replace('/(tabs)/collection'))}
    />
  );
}
