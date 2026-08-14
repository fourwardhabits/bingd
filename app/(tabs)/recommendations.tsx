import { useRouter } from 'expo-router';

import { AppHeader, EmptyState, Screen } from '@/ui/components';

/**
 * PRD §13. Every card renders only structured evidence supplied by the server —
 * the client never composes an explanation of its own (AD-8), because a
 * fabricated reason is worse than no reason.
 */
export default function RecommendationsScreen() {
  const router = useRouter();

  return (
    <Screen>
      <AppHeader />
      <EmptyState
        kind="nothingYet"
        title="Rank a few things first"
        body="Recommendations need a little of your taste to work from."
        action={{ label: 'Start ranking', onPress: () => router.push('/log') }}
      />
    </Screen>
  );
}
