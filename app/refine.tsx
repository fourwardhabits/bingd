import { useLocalSearchParams, useRouter } from 'expo-router';

import { RefineScreen } from '@/features/ranking/RefineScreen';

/**
 * Refine your rankings (T5). Pushed from Collection's `Refine rankings ›`, which is drawn
 * only while the server says Refine is on and has something worth a look — so this route
 * is unreachable while `ranking.refine_enabled` is false. Opened by hand anyway, it asks
 * the server and shows *Not available*.
 *
 * `medium` is validated rather than trusted: an unknown value opens Movies.
 */
export default function RefineRoute() {
  const router = useRouter();
  const { medium } = useLocalSearchParams<{ medium?: string }>();
  return (
    <RefineScreen
      medium={medium === 'tv_seasons' ? 'tv_seasons' : 'movies'}
      onExit={() => (router.canGoBack() ? router.back() : router.replace('/(tabs)/collection'))}
    />
  );
}
